from typing import Optional, List
from pydantic import BaseModel


class SubmitPatchRequest(BaseModel):
    problem_id: Optional[int] = None
    user_code: str
    test_cases: Optional[List[dict]] = None
    language: Optional[str] = "python"
    user_id: Optional[str] = None
    username: Optional[str] = None
    time_seconds: Optional[int] = 0
    access_token: Optional[str] = None


class HintRequest(BaseModel):
    problem_id: Optional[int] = None
    user_code: Optional[str] = None