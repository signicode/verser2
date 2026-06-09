import importlib
import unittest


class ScaffoldTest(unittest.TestCase):
    def test_package_imports(self) -> None:
        package = importlib.import_module("verser2_guest_python")

        self.assertEqual(
            package.VERSER2_GUEST_PYTHON_PACKAGE_NAME,
            "@signicode/verser2-guest-python",
        )


if __name__ == "__main__":
    unittest.main()
