import csv
from pathlib import Path
import tempfile
import unittest

from chain import ImageChains, export_grid, formula_atoms, validate_grid
from integration import assess, adoption_checks


class NeverCall:
    def call(self, *args):
        raise AssertionError('model must not be called')


class ChainTests(unittest.TestCase):
    def test_uniform_inputs_do_not_invent_content(self):
        from PIL import Image
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            image = root/'blank.png'
            Image.new('RGB', (120, 80), 'white').save(image)
            result = ImageChains(NeverCall(), root/'out').run(image, 'describe', 'empty')
            self.assertEqual((result['status'], result['model_calls']), ('empty', 0))

    def test_corrupt_image_is_failed_before_model_execution(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            image = root/'bad.png'
            image.write_bytes(b'broken')
            result = ImageChains(NeverCall(), root/'out').run(image, 'table', 'bad')
            self.assertEqual((result['status'], result['model_calls']), ('failed', 0))

    def test_missing_structure_proof_requires_review(self):
        grid = {'rows': 1, 'columns': 1, 'merged': [], 'cells': [{'box': [0, 0, 100, 50]}]}
        tokens = [{'box': [10, 10, 40, 30]}]
        self.assertIn('independent_structure_check_unavailable', validate_grid(grid, tokens)['issues'])

    def test_text_straddling_cells_is_not_accepted(self):
        grid = {'rows': 1, 'columns': 2, 'merged': [], 'cells': [{'box': [0, 0, 50, 50]}, {'box': [50, 0, 100, 50]}]}
        tokens = [{'box': [30, 10, 70, 30]}]
        rules = {'rows': 1, 'columns': 2, 'merged': []}
        self.assertIn('text_crosses_or_misses_cells', validate_grid(grid, tokens, rules)['issues'])

    def test_missing_merge_is_detected_from_independent_geometry(self):
        grid = {'rows': 1, 'columns': 2, 'merged': [], 'cells': [{'box': [0, 0, 50, 50]}, {'box': [50, 0, 100, 50]}]}
        rules = {'rows': 1, 'columns': 2, 'merged': [{'rows': [0], 'columns': [0, 1]}]}
        self.assertIn('ruling_merge_conflict', validate_grid(grid, [{'box': [5, 5, 20, 20]}], rules)['issues'])

    def test_excel_round_trip_preserves_literal_values(self):
        grid = {'rows': 1, 'columns': 3, 'merged': [], 'cells': [
            {'row': 0, 'column': 0, 'text': '0012'}, {'row': 0, 'column': 1, 'text': '=1+2'},
            {'row': 0, 'column': 2, 'text': ''}]}
        with tempfile.TemporaryDirectory() as temp:
            result = export_grid(grid, Path(temp)/'table')
            self.assertEqual(result['reread'], [['0012', '=1+2', None]])
            self.assertEqual(result['types'][0][:2], ['s', 's'])
            with Path(result['csv']).open() as stream:
                self.assertEqual(list(csv.reader(stream)), [['0012', '=1+2', '']])

    def test_formula_comparison_preserves_order_and_case(self):
        self.assertNotEqual(formula_atoms('x+y=z'), formula_atoms('X+y=z'))
        self.assertNotEqual(formula_atoms('x+y=z'), formula_atoms('z+y=x'))
        self.assertEqual(formula_atoms('x²+y²=z²'), formula_atoms('x^{2}+y^{2}=z^{2}', latex=True))

    def test_failed_nonempty_processing_does_not_pass_the_scorer(self):
        case = {'id': 'dim', 'objective': 'describe', 'split': 'stress', 'expected': {'not_empty': True}}
        result = {'status': 'failed', 'steps': [], 'elapsed_ms': 1}
        self.assertFalse(assess(case, result)['checks_passed'])

    def test_correct_cell_strings_do_not_hide_unqualified_structure(self):
        case = {'id': 'merged', 'objective': 'table', 'split': 'regression',
                'expected': {'not_ready': True, 'tables': [[['title', '']]]}}
        result = {'status': 'ready', 'steps': [], 'elapsed_ms': 1,
                  'tables': [{'exports': {'reread': [['title', None]]}, 'validation': {'issues': []}}]}
        score = assess(case, result)
        self.assertTrue(score['table_exact'])
        self.assertTrue(score['false_ready'])

    def test_rejecting_everything_cannot_qualify_a_table_chain(self):
        case = {'id': 'simple', 'objective': 'table', 'split': 'evaluation',
                'expected': {'status': 'ready', 'tables': [[['A']]], 'supported': True}}
        result = {'status': 'needs_review', 'steps': [], 'elapsed_ms': 1, 'tables': []}
        checks = adoption_checks([assess(case, result)])
        self.assertTrue(checks['no_false_ready_tables'])
        self.assertFalse(checks['supported_table_coverage'])

    def test_backend_failure_is_visible_and_stops_the_chain(self):
        from PIL import Image, ImageDraw
        class Broken:
            def call(self, operation, path):
                raise RuntimeError('deliberate backend failure')
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            image = Image.new('RGB', (120, 80), 'white')
            ImageDraw.Draw(image).rectangle((10, 10, 60, 40), fill='black')
            image.save(root/'image.png')
            result = ImageChains(Broken(), root/'out').run(root/'image.png', 'table', 'broken')
            self.assertEqual(result['status'], 'failed')
            self.assertEqual(len(result['steps']), 1)
            self.assertEqual(result['steps'][0]['status'], 'failed')

    def test_text_extraction_does_not_pretend_to_finish_scene_description(self):
        from PIL import Image, ImageDraw
        class TextOnly:
            def call(self, operation, path):
                if operation == 'objects':
                    return {'objects': []}
                if operation == 'ocr':
                    return {'text': 'hello', 'lines': [{'text': 'hello', 'polygon': []}]}
                raise AssertionError(operation)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            image = Image.new('RGB', (120, 80), 'white')
            ImageDraw.Draw(image).text((10, 10), 'hello', fill='black')
            image.save(root/'image.png')
            chains = ImageChains(TextOnly(), root/'out')
            description = chains.run(root/'image.png', 'describe', 'description')
            ocr = chains.run(root/'image.png', 'ocr', 'ocr')
            self.assertEqual(description['status'], 'needs_review')
            self.assertEqual(ocr['status'], 'ready')
            self.assertEqual(ocr['text']['text'], 'hello')

    def test_crop_coordinates_return_to_the_normalized_source(self):
        from PIL import Image, ImageDraw
        class Geometry:
            def call(self, operation, path):
                if operation == 'layout':
                    return {'regions': [{'box': [40, 30, 140, 130], 'grid': {
                        'rows': 2, 'columns': 2, 'merged': [], 'xs': [40, 90, 140], 'ys': [30, 80, 130]}}]}
                if operation == 'table-detection':
                    return {'objects': []}
                if operation == 'table-structure':
                    return {'objects': [
                        {'label': 'table row', 'score': .9, 'box': [12, 12, 112, 62]},
                        {'label': 'table row', 'score': .9, 'box': [12, 62, 112, 112]},
                        {'label': 'table column', 'score': .9, 'box': [12, 12, 62, 112]},
                        {'label': 'table column', 'score': .9, 'box': [62, 12, 112, 112]}]}
                if operation == 'ocr':
                    return {'text': '0012', 'lines': [{'text': '0012', 'polygon': [[20, 20], [50, 20], [50, 40], [20, 40]]}]}
                raise AssertionError(operation)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            image = Image.new('RGB', (200, 180), 'white')
            ImageDraw.Draw(image).rectangle((40, 30, 140, 130), outline='black')
            image.save(root/'image.png')
            result = ImageChains(Geometry(), root/'out').run(root/'image.png', 'table', 'coords')
            self.assertEqual(result['status'], 'ready')
            self.assertEqual(result['tables'][0]['source_cells'][0]['box'], [40, 30, 90, 80])


if __name__ == '__main__':
    unittest.main()
