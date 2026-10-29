import copy
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
import user_intent


def request():
    return dict(model=user_intent.PUBLIC_MODEL,state={'text':'明日の天気を調べて','previous_agent':None},
                questions={'intent':dict(type='choice',instructions='ユーザー意図',criteria={l:l for l in user_intent.LABELS})})


class IntentTests(unittest.TestCase):
    def test_rejects_mixed_tasks_missing_labels_and_implicit_assistant_input(self):
        state, _ = user_intent.validate_request(request())
        self.assertEqual(state['text'],'明日の天気を調べて')
        for change in ['criteria','state','model','type','empty','long']:
            with self.subTest(change=change):
                body=request()
                if change=='criteria':body['questions']['intent']['criteria'].pop('noise')
                if change=='state':body['state']={'response':'表情用の入力'}
                if change=='model':body['model']='ruri-v3-30m-speaking-attitude'
                if change=='type':body['questions']['intent']['type']='score'
                if change=='empty':body['state']['text']=' '
                if change=='long':body['state']['previous_agent']='x'*50001
                with self.assertRaises(ValueError):user_intent.validate_request(body)

    def test_artifacts_are_pinned_and_calibration_uses_disjoint_fit(self):
        encoder={'revision':'test','files':[{'path':n,'sha256':'a'*64} for n in ['model.onnx','tokenizer.json']]}
        for mutate in [None,'overlap','encoder','shape','temperature','tamper']:
            with self.subTest(mutate=mutate), tempfile.TemporaryDirectory() as tmp:
                root=Path(tmp)
                head=dict(model=user_intent.PUBLIC_MODEL,labels=list(user_intent.LABELS),revision='test',
                          encoder_hashes={n:'a'*64 for n in ['model.onnx','tokenizer.json']},
                          feature_mode='current-plus-context-charhash',encoder_frozen=True,train_only=True,
                          input_contract={'version':'previous-agent-first160-user-latest-v1'},
                          train_ids=['fit'],calibration_ids=['cal'],label_status='fixture',
                          weights=[[0.]*4608 for _ in range(5)],bias=[0.]*5)
                dataset={'split_by_id':{'fit':'fit','cal':'calibration'}}
                (root/'dataset-manifest.json').write_text(json.dumps(dataset))
                head['dataset_manifest_sha256']=hashlib.sha256((root/'dataset-manifest.json').read_bytes()).hexdigest()
                if mutate=='overlap':head['calibration_ids']=['fit']
                if mutate=='encoder':head['revision']='other'
                if mutate=='shape':head['weights'][0].pop()
                (root/'head.json').write_text(json.dumps(head))
                calibration=dict(head_sha256=hashlib.sha256((root/'head.json').read_bytes()).hexdigest(),
                                 calibration_ids=head['calibration_ids'],temperature=0 if mutate=='temperature' else 1.)
                (root/'calibration.json').write_text(json.dumps(calibration))
                (root/'encoder-manifest.json').write_text(json.dumps(encoder))
                manifest=dict(model=user_intent.PUBLIC_MODEL,files=[dict(path=n,bytes=(root/n).stat().st_size,
                               sha256=hashlib.sha256((root/n).read_bytes()).hexdigest()) for n in user_intent.FILES])
                (root/'assets.json').write_text(json.dumps(manifest))
                if mutate=='tamper':(root/'head.json').write_text('{}')
                if mutate is None:self.assertEqual(user_intent.load_head(root,encoder,root/'assets.json')['weights'].shape,(5,4608))
                else:
                    with self.assertRaises(ValueError):user_intent.load_head(root,encoder,root/'assets.json')

    @unittest.skipUnless(os.environ.get('RURI_ARTIFACT_TESTS')=='1','external model integration is opt-in')
    def test_shared_encoder_concurrency_and_training_equivalence(self):
        from concurrent.futures import ThreadPoolExecutor
        import numpy as np
        from fastapi.testclient import TestClient
        from ruri_api import app
        from attitude import LABELS, PUBLIC_MODEL
        predictions=Path('/srv/ai/benchmarks/user-intent/training/2026-10-29-v3/eval-predictions.jsonl')
        rows=[json.loads(l) for l in predictions.read_text().splitlines() if l.strip()]
        with TestClient(app) as client:
            health=client.get('/health').json()
            self.assertEqual(health['encoder_session_count'],1)
            self.assertEqual(set(health['models']),{PUBLIC_MODEL,user_intent.PUBLIC_MODEL})
            for row in rows:
                body=request();body['state']={k:row[k] for k in ['text','previous_agent']}
                result=client.post('/v1/systemone',json=body)
                self.assertEqual(result.status_code,200)
                answer=result.json()['answers']['intent']
                self.assertEqual(answer['choice'],row['prediction'])
                np.testing.assert_allclose([answer['logits'][l] for l in user_intent.LABELS],
                                           [row['logits'][l] for l in user_intent.LABELS],atol=5e-5,rtol=0)
            attitude=dict(model=PUBLIC_MODEL,state={'response':'設定を保存しました。'},questions={
                'emotion':dict(type='choice',instructions='表情',criteria={l:l for l in LABELS})})
            baseline=client.post('/v1/systemone',json=attitude).json()['answers']
            def invoke(i):
                body=attitude if i%2 else request()
                result=client.post('/v1/systemone',json=body)
                self.assertEqual(result.status_code,200)
                if i%2:self.assertEqual(result.json()['answers'],baseline)
            with ThreadPoolExecutor(max_workers=8) as pool:list(pool.map(invoke,range(32)))
            body=request();body['questions']['intent']['criteria']['none']='通常'
            self.assertEqual(client.post('/v1/systemone',json=body).status_code,422)
            body=request();body['model']='unknown'
            self.assertEqual(client.post('/v1/systemone',json=body).status_code,422)


if __name__=='__main__':unittest.main()
