"""Output only ja or en, using a saved external sentence-language classifier."""
import argparse
import json
import sys
from model import SentenceLanguageModel


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--model-dir', required=True)
    parser.add_argument('--text', help='Read UTF-8 text from stdin when omitted')
    parser.add_argument('--json', action='store_true', help='Also show scores and model metadata')
    args = parser.parse_args()
    model = SentenceLanguageModel(args.model_dir)
    text = args.text if args.text is not None else sys.stdin.read()
    prediction = model.predict(text)
    print(json.dumps(prediction, ensure_ascii=False) if args.json else prediction['language'])
