"""Authentication dependency, kept fail-closed until the login phase."""
from fastapi import HTTPException

def get_current_user():
    raise HTTPException(401, "Please log in")
