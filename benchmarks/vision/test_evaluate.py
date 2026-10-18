import unittest

from evaluate import cer, table_grid


class EvaluationTests(unittest.TestCase):
    def test_character_error_retains_missing_whitespace(self):
        self.assertEqual(cer('番号 123', '番号123'),
                         {'edits': 1, 'reference_characters': 6, 'cer': 1/6})

    def test_empty_reference_does_not_claim_zero_error_rate(self):
        self.assertEqual(cer('', 'invented')['edits'], 8)
        self.assertIsNone(cer('', 'invented')['cer'])

    def test_table_text_belongs_to_its_own_column(self):
        objects = [
            {'label': 'table row', 'score': .9, 'box': [0, 0, 100, 50]},
            {'label': 'table column', 'score': .9, 'box': [0, 0, 50, 50]},
            {'label': 'table column', 'score': .9, 'box': [50, 0, 100, 50]},
        ]
        grid = table_grid(objects, [{'text': '0012', 'box': [60, 10, 90, 30]}])
        self.assertEqual([cell['text'] for cell in grid['cells']], ['', '0012'])

    def test_duplicate_rows_do_not_create_phantom_cells(self):
        objects = [
            {'label': 'table row', 'score': .9, 'box': [0, 0, 100, 50]},
            {'label': 'table row', 'score': .7, 'box': [0, 2, 100, 49]},
            {'label': 'table column', 'score': .9, 'box': [0, 0, 100, 50]},
        ]
        self.assertEqual(table_grid(objects, [])['rows'], 1)

    def test_no_detected_table_is_empty(self):
        grid = table_grid([], [{'text': 'text', 'box': [0, 0, 20, 20]}])
        self.assertEqual((grid['rows'], grid['columns'], grid['cells']), (0, 0, []))


if __name__ == '__main__':
    unittest.main()
