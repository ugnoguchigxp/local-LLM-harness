"""LARM d1 game decision endpoint. Authentication and request scheduling live in LARM."""
from contextlib import asynccontextmanager
import os
from fastapi import FastAPI, HTTPException, Request
from engine import Engine


@asynccontextmanager
async def lifespan(app):
    app.state.engine = Engine(os.environ.get('D1_MODEL_ROOT', '/srv/ai/models/d1-2b'),
                              os.environ.get('D1_DEVICE', 'cuda'))
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
    except BlockingIOError as error:
        raise HTTPException(status_code=429, detail='d1 is busy') from error
