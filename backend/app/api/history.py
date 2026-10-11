"""Local-session undo controls."""

from typing import cast

from fastapi import APIRouter, Request

from app.services.history_service import HistoryJournal

router = APIRouter(prefix="/api/history")


def journal(request: Request) -> HistoryJournal:
    return cast(HistoryJournal, request.app.state.history)


@router.get("/status")
async def status(request: Request) -> dict[str, object]:
    return journal(request).status()


@router.post("/undo")
async def undo(request: Request) -> dict[str, object]:
    history = journal(request)
    async with history.lock:
        return history.apply()


@router.post("/redo")
async def redo(request: Request) -> dict[str, object]:
    history = journal(request)
    async with history.lock:
        return history.apply(redo=True)


@router.post("/clear")
async def clear(request: Request) -> dict[str, object]:
    history = journal(request)
    async with history.lock:
        return history.clear()
