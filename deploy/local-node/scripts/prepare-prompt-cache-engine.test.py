import runpy
from pathlib import Path
import unittest


redirected_link = runpy.run_path(str(Path(__file__).with_name("prepare-prompt-cache-engine.py")))["redirected_link"]


class LinkIsolationTests(unittest.TestCase):
    def test_redirects_only_candidate_outputs(self):
        recipe = ["/usr/bin/c++", "server.o", "-Wl,--dependency-file=live/link.d",
                  "-o", "../../bin/llama-server", "libserver-context.a", "../../src/libllama.a"]
        original = recipe.copy()
        actual = redirected_link(recipe, Path("/staging/context.a"), Path("/staging/llama-server"))
        self.assertEqual(actual, ["/usr/bin/c++", "server.o", "-o", "/staging/llama-server",
                                  "/staging/context.a", "../../src/libllama.a"])
        self.assertEqual(recipe, original)

    def test_rejects_ambiguous_or_changed_link_recipes(self):
        for recipe in [
            ["c++", "-o", "live"],
            ["c++", "libserver-context.a"],
            ["c++", "libserver-context.a", "libserver-context.a", "-o", "live"],
            ["c++", "libserver-context.a", "-o", "live", "-o", "another"],
        ]:
            with self.subTest(recipe=recipe), self.assertRaises(SystemExit):
                redirected_link(recipe, Path("/staging/context.a"), Path("/staging/llama-server"))


if __name__ == "__main__":
    unittest.main()
