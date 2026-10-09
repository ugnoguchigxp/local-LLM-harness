"""larm.system-one.v1 adapter for the six speaking-attitude labels."""
from contextlib import asynccontextmanager
import os
from fastapi import FastAPI, HTTPException, Request
from engine import Engine


@asynccontextmanager
async def lifespan(app):
    app.state.engine = Engine(os.environ.get('RURI_MODEL_ROOT', '/srv/ai/models/ruri-speaking-attitude-v1'))
    yield


app = FastAPI(lifespan=lifespan)


@app.get('/health')
def health(request: Request):
    return request.app.state.engine.health()


@app.post('/v1/systemone')
def predict(request: Request, body: dict):
    try:
        return request.app.state.engine.predict(body)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
