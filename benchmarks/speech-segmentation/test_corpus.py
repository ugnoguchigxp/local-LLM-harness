"""Checks synthetic pilot provenance/annotations without model dependencies."""
import unittest
from corpus import corpus


class CorpusTests(unittest.TestCase):
    def test_conversation_template_and_text_do_not_cross_partitions(self):
        rows = corpus()
        self.assertEqual(len(rows), 50)
        for field in ['id', 'conversation_id', 'template_group', 'text']:
            ownership = {}
            for row in rows:
                self.assertNotIn(row[field], ownership, (field, row[field]))
                ownership[row[field]] = row['split']
        self.assertEqual([sum(r['split'] == s for r in rows) for s in ['train', 'calibration', 'evaluation']], [24, 8, 18])

    def test_partial_commitments_and_overrides_are_original_positions(self):
        for row in corpus():
            text = row['text']
            self.assertEqual(''.join(s[0] for s in row['spans']), text)
            ends = {0}
            position = 0
            for span, language, pause in row['spans']:
                self.assertIn(language, ['ja', 'en'])
                self.assertIn(pause, ['none', 'short', 'sentence'])
                position += len(span)
                ends.add(position)
            for prefix, commit in row['partials']:
                self.assertTrue(text.startswith(prefix))
                self.assertIn(commit, ends)
                self.assertLessEqual(commit, len(prefix))
            for start, end, language in row['overrides']:
                self.assertLess(start, end)
                self.assertLessEqual(end, len(text))
                self.assertIn(language, ['ja', 'en'])


if __name__ == '__main__':
    unittest.main()
