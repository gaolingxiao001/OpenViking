"""Async message queue for decoupled channel-agent communication."""

import asyncio
from typing import Callable

from vikingbot.bus.events import InboundMessage, OutboundMessage


class MessageBus:
    """
    Async message bus that decouples chat channels from the agent core.

    Channels push messages to the inbound queue, and the agent processes
    them and pushes responses to the outbound queue.
    """

    def __init__(self):
        self.inbound: asyncio.Queue[InboundMessage] = asyncio.Queue()
        self.outbound: asyncio.Queue[OutboundMessage] = asyncio.Queue()
        self._inbound_changed = asyncio.Condition()

    async def publish_inbound(self, msg: InboundMessage) -> None:
        """Publish a message from a channel to the agent."""
        await self.inbound.put(msg)
        async with self._inbound_changed:
            self._inbound_changed.notify_all()

    async def consume_inbound(self) -> InboundMessage:
        """Consume the next inbound message (blocks until available)."""
        return await self.inbound.get()

    async def publish_outbound(self, msg: OutboundMessage) -> None:
        """Publish a response from the agent to channels."""
        await self.outbound.put(msg)

    async def consume_outbound(self) -> OutboundMessage:
        """Consume the next outbound message (blocks until available)."""
        return await self.outbound.get()

    def count_pending_inbound_session(self, session_key) -> int:
        """Return the number of inbound messages waiting for the session."""
        return sum(1 for msg in list(self.inbound._queue) if msg.session_key == session_key)

    def drain_pending_inbound_session(
        self,
        session_key,
        predicate: Callable[[InboundMessage], bool] | None = None,
    ) -> list[InboundMessage]:
        """Remove and return queued inbound messages for a session, preserving other order."""
        drained: list[InboundMessage] = []
        kept = self.inbound._queue.__class__()
        while self.inbound._queue:
            msg = self.inbound._queue.popleft()
            if msg.session_key == session_key and (predicate is None or predicate(msg)):
                drained.append(msg)
            else:
                kept.append(msg)
        self.inbound._queue = kept
        return drained

    async def wait_for_inbound_change(self) -> None:
        """Wait until a channel publishes an inbound message."""
        async with self._inbound_changed:
            await self._inbound_changed.wait()

    @property
    def inbound_size(self) -> int:
        """Number of pending inbound messages."""
        return self.inbound.qsize()
