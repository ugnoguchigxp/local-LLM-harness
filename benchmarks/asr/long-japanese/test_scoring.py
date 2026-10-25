import unittest

import analyze


class ScoringTests(unittest.TestCase):
    def test_substitution_insertion_deletion(self):
        result=analyze.edits('abc','axcd')
        self.assertEqual((result['substitutions'],result['deletions'],result['insertions']),(1,0,1))
        self.assertEqual(analyze.edits('abc','ac')['deletions'],1)

    def test_empty_output_counts_all_reference_characters(self):
        self.assertEqual(analyze.edits('音声認識','')['edits'],4)

    def test_numeric_spelling_does_not_change_reading_score(self):
        self.assertEqual(analyze.reading('十五時三十分、七千五百円。'),analyze.reading('15時30分、7千5百円。'))

    def test_thousands_separator_does_not_change_numeric_value(self):
        self.assertEqual(analyze.canonical('7,500円と1,200円'),analyze.canonical('七千五百円と千二百円'))

    def test_homophones_remain_distinct_in_critical_phrase_checks(self):
        probe={'kind':'critical','source':'箸','alternatives':[]}
        result=analyze.probe_score('箸','橋',probe)
        self.assertEqual(result['retained'],0)
        self.assertEqual(result['reading_observed'],1)

    def test_repeated_words_are_counted(self):
        probe={'kind':'repetition','source':'会議は','alternatives':[]}
        result=analyze.probe_score('会議は、会議は来週です。','会議は来週です。',probe)
        self.assertEqual((result['expected'],result['retained']),(2,1))

    def test_unmodified_grammar_is_not_counted_as_a_rewrite(self):
        probe={'kind':'spoken_grammar','source':'明日は雨だった','alternatives':['明日は雨だ']}
        result=analyze.probe_score('明日は雨だった','明日は雨だった',probe)
        self.assertEqual(result['alternatives_observed']['明日は雨だ'],0)
        changed=analyze.probe_score('明日は雨だった','明日は雨だ',probe)
        self.assertEqual(changed['alternatives_observed']['明日は雨だ'],1)

    def test_quality_denominator_is_not_inflated_by_timing_repeats(self):
        base={'reference':'あいう','text':'あい','probes':[],'errors':[],'audio_seconds':2,
              'seconds':.2,'last_segment_seconds':.2,'segment_seconds':[.2],'rtf':.1,
              'clip_id':'sample','condition':'clean'}
        rows=[analyze.score({**base,'repeat':i}) for i in range(3)]
        summary=analyze.aggregate(rows)
        self.assertEqual(summary['clips'],1)
        self.assertEqual(summary['attempts'],3)
        self.assertEqual(summary['strict']['units'],3)
        self.assertEqual(summary['strict']['edits'],1)


if __name__=='__main__':
    unittest.main()
