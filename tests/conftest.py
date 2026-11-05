import os
import tempfile

# Never use the user's project data in automated tests.
_test_data = tempfile.TemporaryDirectory(prefix="frame-studio-tests-")
os.environ["FRAME_STUDIO_DATA"] = _test_data.name
