import base64
import unittest

from contract import MODEL, Rejected, validate_request


class RequestContract(unittest.TestCase):
    def request(self, **changes):
        return {"model": MODEL, "image": "data:image/png;base64,YQ==", "task": "referring", "query": "a tool", **changes}

    def test_valid(self):
        value, raw, media = validate_request(self.request())
        self.assertEqual((raw, media, value["maxNewTokens"]), (b"a", "png", 256))
        validate_request(self.request(task="ocr", query=""))
        validate_request(self.request(task="detection", query=["tool", "person"]))

    def test_reject_invalid_and_unbounded_work(self):
        for changes in ({"model": "other"}, {"task": []}, {"query": []}, {"query": ""},
                        {"maxNewTokens": True}, {"maxNewTokens": 513}, {"extra": 1},
                        {"image": "/tmp/a.png"}, {"image": "https://example.com/a.png"},
                        {"image": "data:image/png;base64,a"}, {"image": "a" * 5_600_001},
                        {"image": "data:image/png;base64," + base64.b64encode(b"x" * (4*1024*1024+1)).decode()},
                        {"query": ["x"]}, {"task": "detection", "query": [""]}):
            with self.subTest(changes=list(changes)):
                with self.assertRaises(Rejected):
                    validate_request(self.request(**changes))
        for value in (None, [], "a", {}):
            with self.assertRaises(Rejected):
                validate_request(value)


if __name__ == "__main__":
    unittest.main()
