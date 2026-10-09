import copy
import json
from pathlib import Path
import tempfile
import unittest
from common import LABELS, format_input, load_examples, require_external
from report import metrics, replay, summarize


def row(cid, order, label, scores, transition='initial'):
    return dict(id=f'{cid}:{order}',conversation_id=cid,chunk_order=order,primary_label=label,
                acceptable_labels=[label],expression_transition=transition,tags=[],current_chunk='対象',
                decision_scores=dict(zip(LABELS,scores)))


class ProtocolTests(unittest.TestCase):
    def test_inputs_use_only_allowed_temporal_context(self):
        example=dict(user_utterance='USER_SECRET',current_chunk='CURRENT_TARGET',_previous_chunk='PAST_TARGET',future='FUTURE_SECRET')
        a,b,c=[format_input(example,m) for m in 'ABC']
        self.assertNotIn('USER_SECRET',a)
        self.assertNotIn('PAST_TARGET',a)
        self.assertIn('USER_SECRET',b)
        self.assertNotIn('PAST_TARGET',b)
        self.assertIn('PAST_TARGET',c)
        for text in [a,b,c]:
            self.assertIn('現在チャンク・判断対象',text)
            self.assertIn('CURRENT_TARGET',text)
            self.assertNotIn('FUTURE_SECRET',text)

    def test_conversation_and_template_leakage_rejected(self):
        data=load_examples()
        for field in ['conversation_id','template_group','current_chunk']:
            subset=[copy.deepcopy(data[0]),copy.deepcopy(next(r for r in data if r['split']=='train'))]
            subset[1][field]=subset[0][field]
            with tempfile.TemporaryDirectory() as tmp:
                path=Path(tmp)/'data.jsonl'
                path.write_text('\n'.join(json.dumps({k:v for k,v in r.items() if not k.startswith('_')}) for r in subset))
                with self.assertRaises(ValueError): load_examples(path)

    def test_cannot_store_artifacts_in_repository(self):
        with self.assertRaises(ValueError): require_external(Path(__file__).parent/'output')

    def test_transition_delay_and_censoring(self):
        rows=[row('x',0,'joy',[0,0,4,0,0,0]),
              row('x',1,'none',[0,0,4,0,0,0],'change'),
              row('x',2,'none',[4,0,0,0,0,0],'hold'),
              row('x',3,'curiosity',[4,0,0,0,0,0],'change')]
        m=metrics(replay(rows))
        self.assertEqual(m['n'],4)
        self.assertEqual(m['necessary_change_late']['count'],2)
        self.assertEqual(m['completed_change_delay_chunks'],[1])
        self.assertEqual(m['unresolved_change']['count'],1)
        self.assertEqual(m['unnecessary_switch']['count'],1)

    def test_allowed_labels_do_not_hide_primary_confusion(self):
        r=row('x',0,'empathy',[0,4,0,0,0,0])
        r['acceptable_labels']=['empathy','warmth']
        m=metrics(replay([r]))
        self.assertEqual(m['agreement'],0)
        self.assertEqual(m['unacceptable']['count'],0)
        self.assertEqual(m['confusion_matrix']['counts'][3][1],1)

    def test_no_smoothing_between_conversations(self):
        rows=[row('x',0,'joy',[0,0,10,0,0,0]),row('y',0,'none',[2,0,0,0,0,0])]
        self.assertEqual([p for _,p in replay(rows,alpha=.1)],['joy','none'])

    def test_hysteresis_costs_necessary_change(self):
        rows=[row('x',0,'joy',[0,0,4,0,0,0]),row('x',1,'none',[4,0,3.5,0,0,0],'change')]
        self.assertEqual(metrics(replay(rows))['necessary_change_late']['count'],0)
        self.assertEqual(metrics(replay(rows,hysteresis=1))['necessary_change_late']['count'],1)

    def test_invalid_or_missing_scores_are_rejected(self):
        r=row('x',0,'none',[1,0,0,0,0,0])
        r['decision_scores']['joy']=float('nan')
        with self.assertRaises(ValueError): replay([r])
        r['decision_scores'].pop('joy')
        with self.assertRaises(ValueError): replay([r])

    def test_timing_repetitions_are_not_independent_truth(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp)/'input'; folder.mkdir()
            for rep in range(3):
                records=[]
                for split in ['eval','calibration']:
                    r=row(split,0,'none',[2,0,0,0,0,0])
                    r.update(split=split,repetition=rep,mode='A',variant='fixture',input_sha256='fixed',
                             raw_scores=r['decision_scores'],inference_ms=rep+1,cpu_ms=rep+1,
                             token_count=10,truncated=False)
                    records.append(r)
                file=folder/f'fixture-rep{rep}.jsonl'
                file.write_text('\n'.join(json.dumps(r) for r in records))
                file.with_suffix('.meta.json').write_text(json.dumps(dict(load_ms=1,candidate_cache_ms=0,
                    memory_peak_observed_kib={'Rss':1,'Pss':1,'Swap':0},memory_baseline_kib={},memory_loaded_kib={},
                    data_sha256='fixed',revision='pinned',runtime={})))
            out=Path(tmp)/'out'; out.mkdir()
            result=summarize([folder],out)[0]
            self.assertEqual(result['quality']['n'],1)
            self.assertEqual(result['performance']['timing_samples'],3)
            # Missing repetition is an error, not an opportunity to report partial comparisons.
            (folder/'fixture-rep2.jsonl').unlink()
            with self.assertRaises(ValueError): summarize([folder],out)


if __name__=='__main__': unittest.main()
