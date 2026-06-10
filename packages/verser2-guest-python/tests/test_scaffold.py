import importlib
import runpy
from pathlib import Path
import unittest


class ScaffoldTest(unittest.TestCase):
    def test_package_imports(self) -> None:
        package = importlib.import_module("verser2_guest_python")

        self.assertEqual(
            package.VERSER2_GUEST_PYTHON_PACKAGE_NAME,
            "@signicode/verser2-guest-python",
        )

    def test_plain_asgi_example_imports(self) -> None:
        example_path = Path(__file__).resolve().parents[1] / "examples" / "plain_asgi.py"
        namespace = runpy.run_path(str(example_path))

        self.assertIn("app", namespace)


if __name__ == "__main__":
    unittest.main()
