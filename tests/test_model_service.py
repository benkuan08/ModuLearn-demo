"""Model service checks with mocked CUDA/model; no weight download or real GPU."""
import asyncio
import types
import unittest
from contextlib import contextmanager
from unittest.mock import MagicMock, patch

from fastapi import HTTPException
from notebooks.gemma_service import Completion, app, complete, lifespan


MODEL = 'google/gemma-4-E2B-it'


class OutOfMemory(RuntimeError):
    pass


class Inputs(dict):
    def __init__(self, length):
        super().__init__(input_ids=types.SimpleNamespace(shape=(1, length)))

    def to(self, device):
        return self


class ModelServiceTests(unittest.TestCase):
    def setUp(self):
        state = dict(app.state._state)
        self.addCleanup(lambda: (app.state._state.clear(), app.state._state.update(state)))

    @contextmanager
    def runtime(self, *, bf16=False, model_type='gemma4', **env):
        torch = MagicMock()
        torch.cuda.is_available.return_value = True
        torch.cuda.is_bf16_supported.return_value = bf16
        torch.cuda.get_device_properties.return_value.total_memory = 15 * 2**30
        torch.cuda.OutOfMemoryError = OutOfMemory
        torch.float32, torch.bfloat16 = 'fp32', 'bf16'
        text_config = types.SimpleNamespace(model_type='gemma4_text', max_position_embeddings=131072, eos_token_id=1)
        config = types.SimpleNamespace(model_type=model_type, text_config=text_config)
        model = MagicMock(config=text_config)
        model.generation_config.eos_token_id = [1, 106]
        tokenizer = MagicMock(eos_token_id=1)
        tokenizer.apply_chat_template.return_value = Inputs(10)
        tokenizer.decode.return_value = '{"ready": true}'
        model.generate.return_value = [[0] * 10 + [5, 106]]
        transformers = MagicMock()
        transformers.AutoConfig.from_pretrained.return_value = config
        for loader in ['Gemma4ForCausalLM', 'AutoModelForCausalLM', 'AutoModelForImageTextToText']:
            getattr(transformers, loader).from_pretrained.return_value = (model, {'missing_keys': [], 'mismatched_keys': []})
        transformers.AutoTokenizer.from_pretrained.return_value = tokenizer
        transformers.AutoProcessor.from_pretrained.return_value = tokenizer
        with patch.dict('sys.modules', torch=torch, transformers=transformers), patch.dict(
                'os.environ', {'MODEL_SERVICE_TOKEN': 'FAKE', **env}, clear=True):
            yield torch, transformers, model, tokenizer

    def request(self, **values):
        return Completion(model=MODEL, messages=[{'role': 'user', 'content': 'Return JSON.'}],
                          **{'max_tokens': 128, 'temperature': 0, **values})

    def test_t4_default_uses_nf4_fp32_and_only_the_gemma4_language_model(self):
        with self.runtime(MODEL_REVISION='pinned-revision') as (torch, transformers, _, _):
            async def check():
                async with lifespan(app):
                    self.assertEqual(app.state.model_id, MODEL)
                    self.assertEqual(app.state.context, 16384)
                    self.assertEqual(app.state.end_tokens, {1, 106})
            asyncio.run(check())
            options = transformers.Gemma4ForCausalLM.from_pretrained.call_args.kwargs
            self.assertEqual(options['dtype'], 'fp32')
            self.assertEqual(options['revision'], 'pinned-revision')
            self.assertEqual(options['device_map'], {'': 0})
            self.assertEqual(options['key_mapping'], {r'^model\.language_model\.': 'model.'})
            self.assertTrue(options['output_loading_info'])
            quant = transformers.BitsAndBytesConfig.call_args.kwargs
            self.assertTrue(quant['load_in_4bit'])
            self.assertEqual(quant['bnb_4bit_quant_type'], 'nf4')
            self.assertEqual(quant['bnb_4bit_compute_dtype'], 'fp32')
            self.assertTrue(quant['bnb_4bit_use_double_quant'])
            transformers.AutoProcessor.from_pretrained.assert_not_called()
            transformers.AutoModelForImageTextToText.from_pretrained.assert_not_called()
            transformers.AutoModelForCausalLM.from_pretrained.assert_not_called()
            transformers.AutoTokenizer.from_pretrained.assert_called_once_with(MODEL, revision='pinned-revision')
            torch.cuda.empty_cache.assert_called_once()

    def test_bf16_capable_gpu_uses_native_bf16_for_nf4(self):
        with self.runtime(bf16=True) as (_, transformers, _, _):
            async def check():
                async with lifespan(app):
                    pass
            asyncio.run(check())
            self.assertEqual(transformers.Gemma4ForCausalLM.from_pretrained.call_args.kwargs['dtype'], 'bf16')
            self.assertEqual(transformers.BitsAndBytesConfig.call_args.kwargs['bnb_4bit_compute_dtype'], 'bf16')

    def test_missing_checkpoint_weights_never_mark_a_randomly_initialized_model_ready(self):
        with self.runtime() as (_, transformers, model, _):
            transformers.Gemma4ForCausalLM.from_pretrained.return_value = (
                model, {'missing_keys': ['model.per_layer_model_projection.weight'], 'mismatched_keys': []})
            async def check():
                async with lifespan(app):
                    self.fail('A checkpoint with missing text weights cannot start.')
            with self.assertRaisesRegex(RuntimeError, 'missing or mismatched weights'):
                asyncio.run(check())
            model.generate.assert_not_called()

    def test_explicit_bf16_is_rejected_on_t4_before_loading_weights(self):
        with self.runtime(MODEL_QUANTIZATION='bf16') as (_, transformers, _, _):
            async def check():
                async with lifespan(app):
                    self.fail('T4 cannot enter a BF16 runtime.')
            with self.assertRaisesRegex(RuntimeError, 'BF16 requires'):
                asyncio.run(check())
            transformers.Gemma4ForCausalLM.from_pretrained.assert_not_called()

    def test_context_limit_rejects_the_full_request_without_generation_or_truncation(self):
        with self.runtime(MAX_CONTEXT_TOKENS='100') as (_, _, model, tokenizer):
            async def check():
                async with lifespan(app):
                    with self.assertRaises(HTTPException) as error:
                        complete(self.request(), 'Bearer FAKE')
                    self.assertEqual(error.exception.status_code, 413)
                    self.assertIn('No input was truncated', error.exception.detail)
                    model.generate.assert_not_called()
                    self.assertNotIn('truncation', tokenizer.apply_chat_template.call_args.kwargs)
            asyncio.run(check())

    def test_gemma4_generation_keeps_last_logits_disables_thinking_and_counts_end_of_turn(self):
        with self.runtime() as (_, _, model, tokenizer):
            async def check():
                async with lifespan(app):
                    result = complete(self.request(), 'Bearer FAKE')
                    self.assertEqual(result['choices'][0]['finish_reason'], 'stop')
                    self.assertEqual(result['choices'][0]['message']['content'], '{"ready": true}')
                    self.assertEqual(result['usage']['total_tokens'], 12)
                    self.assertFalse(tokenizer.apply_chat_template.call_args.kwargs['enable_thinking'])
                    self.assertEqual(model.generate.call_args.kwargs['logits_to_keep'], 1)
                    self.assertFalse(model.generate.call_args.kwargs['do_sample'])
                    model.generate.return_value = [[0] * 10 + [5]]
                    self.assertEqual(complete(self.request(), 'Bearer FAKE')['choices'][0]['finish_reason'], 'length')
            asyncio.run(check())

    def test_out_of_memory_returns_a_visible_error_without_a_completion(self):
        with self.runtime() as (torch, _, model, _):
            model.generate.side_effect = OutOfMemory()
            async def check():
                async with lifespan(app):
                    with self.assertRaises(HTTPException) as error:
                        complete(self.request(), 'Bearer FAKE')
                    self.assertEqual(error.exception.status_code, 507)
                    self.assertIn('No grade was recorded', error.exception.detail)
                    torch.cuda.empty_cache.assert_called_once()
            asyncio.run(check())

    def test_private_model_requests_require_authentication_and_matching_checkpoint(self):
        with self.runtime() as (_, _, model, _):
            async def check():
                async with lifespan(app):
                    for request, token, code in [
                        (self.request(), 'Bearer WRONG', 401),
                        (Completion(model='wrong-checkpoint', messages=[{'role': 'user', 'content': 'Hi'}]), 'Bearer FAKE', 400),
                    ]:
                        with self.assertRaises(HTTPException) as error:
                            complete(request, token)
                        self.assertEqual(error.exception.status_code, code)
                    model.generate.assert_not_called()
            asyncio.run(check())


if __name__ == '__main__':
    unittest.main()
