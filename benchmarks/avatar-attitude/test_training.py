import importlib.util
import unittest

from train_head import fit_classifier


@unittest.skipUnless(importlib.util.find_spec('sklearn') and importlib.util.find_spec('numpy'),
                     'numerical tests require the pinned avatar-attitude environment')
class TrainingTests(unittest.TestCase):
    def test_group_cv_produces_15_class_head_without_calibration_input(self):
        import numpy as np
        labels = ['none'] + [f'class_{i}' for i in range(14)]
        y = np.repeat(np.arange(15), 18)
        x = np.eye(15)[y]
        groups = np.array([f'{label}-{i//2}' for label in range(15) for i in range(18)])
        fitted, trials = fit_classifier(x, y, groups, labels, True)
        self.assertEqual(fitted.coef_.shape, (15, 15))
        self.assertTrue(np.array_equal(fitted.predict(x), y))
        self.assertEqual(len(trials), 4)
        self.assertTrue(all(len(t['fold_scores'])==3 for t in trials))

    def test_cv_rejects_one_group_per_class(self):
        import numpy as np
        with self.assertRaises(ValueError):
            fit_classifier(np.eye(3), np.arange(3), np.arange(3), ['none','joy','anger'], True)


if __name__ == '__main__':
    unittest.main()
