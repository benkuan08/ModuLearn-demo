"""Private, text-only Gemma service for the Colab GPU runtime.

The website uses this OpenAI-compatible endpoint without sending weights or
credentials to the browser. Heavy imports and model loading happen at startup.
"""
import hmac
import os
import threading
import time
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field


class Message(BaseModel):
    model_config = ConfigDict(extra='forbid')
    role: Literal['system', 'user', 'assistant']
    content: str = Field(max_length=1_000_000)


class Completion(BaseModel):
    model_config = ConfigDict(extra='forbid')
    model: str
    messages: list[Message] = Field(min_length=1, max_length=8)
    max_tokens: int = Field(default=4096, ge=1, le=32768)
    stream: Literal[False] = False
    temperature: float = Field(default=1.0, ge=0, le=2)
    top_p: float = Field(default=0.95, gt=0, le=1)


def token_ids(value):
    if value is None:
        return set()
    return {value} if isinstance(value, int) else set(value)


def load_checkpoint(loader, model_id, *, is_gemma4=False, **options):
    if is_gemma4:
        # Google's multimodal checkpoint nests text weights under this prefix.
        # Without explicit mapping, Transformers 5.23 initializes missing text
        # parameters instead; their Linear4bit layers have no quant_state.
        options['key_mapping'] = {r'^model\.language_model\.': 'model.'}
    model, loading_info = loader.from_pretrained(model_id, output_loading_info=True, **options)
    if is_gemma4 and (loading_info.get('missing_keys') or loading_info.get('mismatched_keys')):
        missing = ', '.join(sorted(loading_info.get('missing_keys', []))[:8])
        raise RuntimeError(f'Gemma text checkpoint has missing or mismatched weights ({missing}). '
                           'The model was not started; check the checkpoint key mapping.')
    return model


@asynccontextmanager
async def lifespan(app):
    import torch
    from transformers import (AutoConfig, AutoModelForCausalLM, AutoModelForImageTextToText,
                              AutoProcessor, AutoTokenizer, BitsAndBytesConfig, Gemma4ForCausalLM)

    token = os.environ.get('MODEL_SERVICE_TOKEN', '')
    if not token:
        raise RuntimeError('MODEL_SERVICE_TOKEN must be set by the Colab launcher.')
    if not torch.cuda.is_available():
        raise RuntimeError('Select a GPU runtime in Colab, or choose hosted mode.')
    total = torch.cuda.get_device_properties(0).total_memory
    if total < 12 * 2**30:
        raise RuntimeError('Select a T4 GPU runtime (about 15 GiB usable VRAM) or hosted mode.')
    model_id = os.environ.get('MODEL_ID', 'google/gemma-4-E2B-it')
    revision = os.environ.get('MODEL_REVISION', 'main')
    quantization = os.environ.get('MODEL_QUANTIZATION', 'nf4')
    # T4 has no native BF16. Keep non-quantized layers and NF4 arithmetic in
    # FP32 there; do not force Gemma's BF16-trained weights into FP16.
    dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float32
    options = {'revision': revision, 'device_map': {'': 0}, 'dtype': dtype, 'attn_implementation': 'sdpa'}
    if quantization == 'nf4':
        options['quantization_config'] = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type='nf4',
                                                           bnb_4bit_use_double_quant=True, bnb_4bit_compute_dtype=dtype)
    elif quantization == 'fp32':
        options['dtype'] = torch.float32
    elif quantization == 'bf16':
        if not torch.cuda.is_bf16_supported():
            raise RuntimeError('BF16 requires a newer GPU. Use fp32 or nf4 on T4.')
        options['dtype'] = torch.bfloat16
    else:
        raise RuntimeError('MODEL_QUANTIZATION must be fp32, nf4 or bf16.')
    config = AutoConfig.from_pretrained(model_id, revision=revision)
    is_gemma4 = config.model_type in {'gemma4', 'gemma4_text'}
    is_multimodal = hasattr(config, 'text_config') and not is_gemma4
    processor = (AutoProcessor if is_multimodal else AutoTokenizer).from_pretrained(model_id, revision=revision)
    # The tutor consumes extracted text. This supported loader reads the same
    # checkpoint's language weights without allocating its vision/audio towers.
    loader = Gemma4ForCausalLM if is_gemma4 else (AutoModelForImageTextToText if is_multimodal else AutoModelForCausalLM)
    model = load_checkpoint(loader, model_id, is_gemma4=is_gemma4, **options)
    model.eval()
    text_config = getattr(model.config, 'text_config', model.config)
    model_limit = getattr(text_config, 'max_position_embeddings', 262144)
    requested_context = int(os.environ.get('MAX_CONTEXT_TOKENS', '16384'))
    if requested_context < 1:
        raise RuntimeError('MAX_CONTEXT_TOKENS must be a positive integer.')
    app.state.context = min(requested_context, model_limit)
    app.state.model_id, app.state.token = model_id, token
    app.state.model, app.state.processor = model, processor
    app.state.torch, app.state.lock = torch, threading.Lock()
    tokenizer = getattr(processor, 'tokenizer', processor)
    app.state.end_tokens = token_ids(model.generation_config.eos_token_id) | token_ids(tokenizer.eos_token_id) | token_ids(getattr(text_config, 'eos_token_id', None))
    print(f'Loaded {model_id} at revision {revision} ({quantization}, compute {options["dtype"]}); '
          f'context budget {app.state.context:,} tokens.', flush=True)
    try:
        yield
    finally:
        del app.state.model
        torch.cuda.empty_cache()


app = FastAPI(title='Private ModuLearn Colab model', lifespan=lifespan)


def authenticate(authorization):
    if not hmac.compare_digest(authorization, 'Bearer ' + app.state.token):
        raise HTTPException(401, 'Private model authentication required.')


@app.get('/health')
def health():
    return {'ready': True, 'model': app.state.model_id, 'context_tokens': app.state.context}


@app.get('/v1/models')
def models(authorization: str = Header(default='')):
    authenticate(authorization)
    return {'object': 'list', 'data': [{'id': app.state.model_id, 'object': 'model', 'owned_by': 'local-colab'}]}


@app.post('/v1/chat/completions')
def complete(body: Completion, authorization: str = Header(default='')):
    authenticate(authorization)
    if body.model != app.state.model_id:
        raise HTTPException(400, 'The requested model does not match the loaded checkpoint.')
    torch, processor = app.state.torch, app.state.processor
    with app.state.lock:
        inputs = processor.apply_chat_template([m.model_dump() for m in body.messages], tokenize=True,
                    return_dict=True, return_tensors='pt', add_generation_prompt=True, enable_thinking=False)
        prompt_length = inputs['input_ids'].shape[-1]
        if prompt_length + body.max_tokens > app.state.context:
            raise HTTPException(413, f'This request needs {prompt_length + body.max_tokens:,} tokens; context budget is {app.state.context:,}. No input was truncated.')
        inputs = inputs.to(app.state.model.device)
        options = {'max_new_tokens': body.max_tokens, 'do_sample': body.temperature > 0}
        if getattr(app.state.model.config, 'model_type', '') in {'gemma3_text', 'gemma4', 'gemma4_text'}:
            # Avoid materializing a full prompt-length x vocabulary logits tensor.
            options['logits_to_keep'] = 1
        if body.temperature > 0:
            options.update(temperature=body.temperature, top_p=body.top_p, top_k=64)
        try:
            with torch.inference_mode():
                output = app.state.model.generate(**inputs, **options)
            generated = output[0][prompt_length:]
            count = len(generated)
            stopped = count > 0 and int(generated[-1]) in app.state.end_tokens
            text = processor.decode(generated, skip_special_tokens=True)
        except torch.cuda.OutOfMemoryError:
            torch.cuda.empty_cache()
            raise HTTPException(507, 'The Colab GPU ran out of memory. Reduce MAX_CONTEXT_TOKENS and the request size, or use a smaller model. No grade was recorded.') from None
        return {'id': 'colab-' + str(time.time_ns()), 'object': 'chat.completion', 'created': int(time.time()),
                'model': app.state.model_id, 'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': text},
                    'finish_reason': 'stop' if stopped else 'length'}],
                'usage': {'prompt_tokens': prompt_length, 'completion_tokens': count, 'total_tokens': prompt_length + count}}
