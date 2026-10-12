"""Corpus provenance checks that need no encoder or training environment."""
import copy
import json
from pathlib import Path
import unittest
from corpus import rows, validate
from evaluation50 import rows as new_rows, validate as validate_new


class CorpusTests(unittest.TestCase):
    def test_exact_training_counts_and_frozen_source_file(self):
        data = rows()
        counts = validate(data)
        self.assertEqual(counts['train-ja'], 200)
        self.assertEqual(counts['train-en'], 200)
        saved = [json.loads(line) for line in Path(__file__).with_name('examples.jsonl').read_text().splitlines()]
        self.assertEqual(saved, data)
        self.assertEqual(len(saved), 640)
        training = [json.loads(line) for line in Path(__file__).with_name('training400.jsonl').read_text().splitlines()]
        self.assertEqual(training, [row for row in data if row['split'] == 'train'])

    def test_paired_translations_and_topic_groups_stay_in_one_split(self):
        data = rows()
        for field in ['conversation_id', 'template_group']:
            owners = {}
            for row in data:
                owners.setdefault(row[field], set()).add(row['split'])
            self.assertTrue(all(len(splits) == 1 for splits in owners.values()))
        conversations = {}
        for row in data:
            conversations.setdefault(row['conversation_id'], []).append(row)
        self.assertTrue(all({r['language'] for r in values} == {'ja', 'en'} and len(values) == 2 for values in conversations.values()))

    def test_leaked_groups_duplicates_and_changed_counts_are_rejected(self):
        original = rows()
        self.assertRaises(ValueError, validate, original + [original[0]])
        self.assertRaises(ValueError, validate, original[:-1])
        for field in ['conversation_id', 'template_group', 'text']:
            data = copy.deepcopy(original)
            evaluation = next(row for row in data if row['split'] == 'evaluation')
            evaluation[field] = data[0][field]
            self.assertRaises(ValueError, validate, data)

    def test_fifty_new_sentences_are_disjoint_and_frozen(self):
        data = new_rows()
        validate_new(data)
        saved = [json.loads(line) for line in Path(__file__).with_name('evaluation50.jsonl').read_text().splitlines()]
        self.assertEqual(saved, data)
        self.assertEqual(len(data), 50)
        self.assertEqual(sum(r['language'] == 'ja' for r in data), 25)
        self.assertEqual(sum(r['language'] == 'en' for r in data), 25)
        duplicated = copy.deepcopy(data)
        duplicated[0]['text'] = rows()[0]['text']
        self.assertRaises(ValueError, validate_new, duplicated)


if __name__ == '__main__':
    unittest.main()
