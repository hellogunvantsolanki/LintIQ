from typing import Optional, List
from pydantic import BaseModel, Field


class SubmitPatchRequest(BaseModel):
    problem_id: Optional[int] = None
    user_code: str = Field(..., max_length=65536)
    test_cases: Optional[List[dict]] = None
    language: Optional[str] = "python"
    user_id: Optional[str] = None
    username: Optional[str] = None
    time_seconds: Optional[int] = 0
    access_token: Optional[str] = None


class RunCodeRequest(BaseModel):
    problem_id: Optional[int] = None
    user_code: str = Field(..., max_length=65536)
    stdin: Optional[str] = Field("", max_length=32768)
    language: Optional[str] = "python"


class HintRequest(BaseModel):
    problem_id: Optional[int] = None
    user_code: Optional[str] = Field(None, max_length=65536)


class ReviewPatchRequest(BaseModel):
    problem_id: int
    user_code: str = Field(..., max_length=65536)
    language: str = Field("python", max_length=32)