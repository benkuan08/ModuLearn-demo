"""Optional offline integration regression; uses real PyTorch/Transformers/bnb.

Run: python tests/check_nf4_loading.py -v
No Google model download, authentication, CUDA or Colab session is needed.
The tiny model tests checkpoint loading and generation, not teaching quality.
"""
import sys
import tempfile
import unittest
import warnings
from pathlib import Path

import torch
from bitsandbytes.nn import Linear4bit
from safetensors.torch import save_file
from transformers import BitsAndBytesConfig, Gemma4Config, Gemma4ForCausalLM, Gemma4TextConfig
from transformers.utils import logging

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from notebooks.gemma_service import load_checkpoint


class CheckpointLoadingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        logging.set_verbosity_error()
        torch.set_num_threads(2)
        cls.folder = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.folder.cleanup)
        root = Path(cls.folder.name)
        cls.native, cls.wrapped = root / 'native', root / 'wrapped'
        config = Gemma4TextConfig(vocab_size=128, vocab_size_per_layer_input=128,
            hidden_size=128, intermediate_size=256, num_hidden_layers=2,
            num_attention_heads=2, num_key_value_heads=1, head_dim=64, global_head_dim=64,
            hidden_size_per_layer_input=64, max_position_embeddings=128, sliding_window=16,
            layer_types=['sliding_attention', 'full_attention'])
        torch.manual_seed(1)
        original = Gemma4ForCausalLM(config).eval()
        original.save_pretrained(cls.native)
        cls.wrapped.mkdir()
        Gemma4Config(text_config=config).save_pretrained(cls.wrapped)
        save_file({'model.language_model.' + key.removeprefix('model.'): value.contiguous()
                   for key, value in original.state_dict().items() if key.startswith('model.')},
                  cls.wrapped / 'model.safetensors', metadata={'format': 'pt'})
        cls.embedding = original.model.embed_tokens.weight.detach().clone()

    def options(self):
        return dict(dtype=torch.float32, device_map={'': 'cpu'}, attn_implementation='sdpa',
                    local_files_only=True, quantization_config=BitsAndBytesConfig(load_in_4bit=True,
                        bnb_4bit_quant_type='nf4', bnb_4bit_use_double_quant=True,
                        bnb_4bit_compute_dtype=torch.float32))

    def test_mapping_loads_real_weights_initializes_nf4_and_matches_native_text_checkpoint(self):
        outputs = []
        for path in [self.native, self.wrapped]:
            with self.subTest(checkpoint=path.name):
                model = load_checkpoint(Gemma4ForCausalLM, path, is_gemma4=True, **self.options())
                self.assertTrue(torch.equal(model.model.embed_tokens.weight, self.embedding))
                layers = [layer for layer in model.modules() if isinstance(layer, Linear4bit)]
                self.assertGreater(len(layers), 0)
                self.assertTrue(all(layer.weight.quant_state is not None for layer in layers))
                with torch.inference_mode():
                    outputs.append(model.generate(torch.tensor([[2, 7, 9]]), max_new_tokens=2,
                                                  do_sample=False, logits_to_keep=1))
                self.assertEqual(outputs[-1].shape, (1, 5))
        self.assertTrue(torch.equal(outputs[0], outputs[1]))

    def test_unmapped_checkpoint_reproduces_the_reported_first_projection_assertion(self):
        model, info = Gemma4ForCausalLM.from_pretrained(self.wrapped, output_loading_info=True, **self.options())
        self.assertIn('model.per_layer_model_projection.weight', info['missing_keys'])
        self.assertIsNone(getattr(model.model.per_layer_model_projection.weight, 'quant_state', None))
        with warnings.catch_warnings(), self.assertRaises(AssertionError), torch.inference_mode():
            warnings.simplefilter('ignore')
            model.generate(torch.tensor([[2, 7, 9]]), max_new_tokens=2, do_sample=False, logits_to_keep=1)


if __name__ == '__main__':
    unittest.main()
