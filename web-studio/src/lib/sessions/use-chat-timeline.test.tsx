// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { fetchSse } from '#/lib/sse'
import { useChat } from './use-chat'

const {
  addMessageMock,
  interruptChatSessionMock,
  sendChatStreamMock,
  steerChatSessionMock,
} =
  vi.hoisted(() => ({
    addMessageMock: vi.fn(),
    interruptChatSessionMock: vi.fn(),
    sendChatStreamMock: vi.fn(),
    steerChatSessionMock: vi.fn(),
  }))

vi.mock('./api', () => ({
  addMessage: addMessageMock,
  interruptChatSession: interruptChatSessionMock,
  sendChatStream: sendChatStreamMock,
  steerChatSession: steerChatSessionMock,
  serializeParts: vi.fn(),
}))

vi.mock('./use-session-titles', () => ({
  setSessionTitle: vi.fn(),
}))

vi.mock('../browser-crypto', () => ({
  createBrowserId: vi.fn((prefix: string) => `${prefix}-id`),
}))

function streamResponse(
  events: Array<{ event: string; data: unknown }>,
): Response {
  const payload = events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join('')
  return new Response(payload, {
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

function streamMessages(events: Array<{ event: string; data: unknown }>) {
  return fetchSse('/stream', {
    fetch: vi.fn().mockResolvedValue(streamResponse(events)),
  })
}

describe('useChat event timeline', () => {
  beforeEach(() => {
    addMessageMock.mockReset()
    interruptChatSessionMock.mockReset()
    interruptChatSessionMock.mockResolvedValue({ interrupted: false })
    sendChatStreamMock.mockReset()
    steerChatSessionMock.mockReset()
    steerChatSessionMock.mockResolvedValue({ accepted: true })
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })

  it('keeps grouped event blocks in SSE arrival order', async () => {
    sendChatStreamMock.mockResolvedValue(
      streamMessages([
        { event: 'iteration', data: 'Iteration 1/10' },
        { event: 'reasoning_delta', data: 'first reasoning' },
        { event: 'content_delta', data: 'checking' },
        { event: 'tool_call', data: 'search({})' },
        { event: 'tool_result', data: '{"ok":true}' },
        { event: 'iteration', data: 'Iteration 2/10' },
        { event: 'reasoning', data: 'second reasoning' },
        { event: 'content_delta', data: 'final' },
        { event: 'response', data: { content: 'final' } },
      ]),
    )

    const { result } = renderHook(() =>
      useChat({
        identityScopeKey: 'identity',
        persistMessages: false,
        sessionId: 'session-1',
      }),
    )

    await act(async () => {
      await result.current.send('hello')
    })

    expect(result.current.messages[1]?.parts.map((part) => part.type)).toEqual([
      'iteration',
      'reasoning',
      'text',
      'tool',
      'tool_result',
      'iteration',
      'reasoning',
      'text',
    ])
    expect(result.current.messages[1]?.parts[3]).toMatchObject({
      tool_name: 'search',
      tool_output: '{"ok":true}',
      tool_status: 'completed',
    })
    expect(result.current.messages[1]?.parts[4]).toMatchObject({
      tool_name: 'search',
      tool_output: '{"ok":true}',
      type: 'tool_result',
    })
    expect(
      result.current.messages[1]?.parts
        .filter((part) => part.type === 'reasoning')
        .map((part) => part.is_running),
    ).toEqual([false, false])
  })

  it('keeps only the latest reasoning block running', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const encoder = new TextEncoder()
    sendChatStreamMock.mockResolvedValue(
      fetchSse('/stream', {
        fetch: vi.fn().mockResolvedValue(
          new Response(
            new ReadableStream<Uint8Array>({
              start(streamController) {
                controller = streamController
              },
            }),
            { headers: { 'Content-Type': 'text/event-stream' } },
          ),
        ),
      }),
    )

    const { result } = renderHook(() =>
      useChat({
        identityScopeKey: 'identity',
        persistMessages: false,
        sessionId: 'session-1',
      }),
    )

    let sendPromise!: Promise<void>
    await act(async () => {
      sendPromise = result.current.send('hello')
      controller.enqueue(
        encoder.encode(
          [
            { event: 'reasoning_delta', data: 'first' },
            { event: 'tool_call', data: 'search({})' },
            { event: 'tool_result', data: '{}' },
            { event: 'reasoning_delta', data: 'second' },
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(''),
        ),
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(
      result.current.streamingParts
        .filter((part) => part.type === 'reasoning')
        .map((part) => part.is_running),
    ).toEqual([false, true])

    await act(async () => {
      controller.close()
      await sendPromise
    })
  })

  it('renders a complete reasoning event as completed', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const encoder = new TextEncoder()
    sendChatStreamMock.mockResolvedValue(
      fetchSse('/stream', {
        fetch: vi.fn().mockResolvedValue(
          new Response(
            new ReadableStream<Uint8Array>({
              start(streamController) {
                controller = streamController
              },
            }),
            { headers: { 'Content-Type': 'text/event-stream' } },
          ),
        ),
      }),
    )

    const { result } = renderHook(() =>
      useChat({
        identityScopeKey: 'identity',
        persistMessages: false,
        sessionId: 'session-1',
      }),
    )

    let sendPromise!: Promise<void>
    await act(async () => {
      sendPromise = result.current.send('hello')
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            event: 'reasoning',
            data: 'complete reasoning',
          })}\n\n`,
        ),
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(result.current.streamingParts).toContainEqual({
      type: 'reasoning',
      reasoning: 'complete reasoning',
      is_running: false,
    })

    await act(async () => {
      controller.close()
      await sendPromise
    })
  })

  it('finalizes when the response event arrives before the stream closes', async () => {
    let streamReleased = false
    async function* stream() {
      try {
        yield {
          data: JSON.stringify({ event: 'response', data: 'final response' }),
          event: '',
          id: '',
        }
        await new Promise(() => {})
      } finally {
        streamReleased = true
      }
    }
    sendChatStreamMock.mockResolvedValue(stream())

    const { result } = renderHook(() =>
      useChat({
        identityScopeKey: 'identity',
        persistMessages: false,
        sessionId: 'session-1',
      }),
    )

    await act(async () => {
      await result.current.send('hello')
    })

    expect(result.current.status).toBe('idle')
    expect(result.current.messages[1]?.parts).toContainEqual({
      text: 'final response',
      type: 'text',
    })
    expect(streamReleased).toBe(true)
  })

  it('requests a backend interrupt before falling back to local abort', async () => {
    sendChatStreamMock.mockImplementation((_request, signal: AbortSignal) =>
      fetchSse('/stream', {
        signal,
        fetch: vi
          .fn()
          .mockResolvedValue(
            new Response(new ReadableStream<Uint8Array>(), {
              headers: { 'Content-Type': 'text/event-stream' },
            }),
          ),
      }),
    )

    const { result } = renderHook(() =>
      useChat({
        identityScopeKey: 'identity',
        persistMessages: false,
        sessionId: 'session-1',
      }),
    )

    let sendPromise!: Promise<void>
    await act(async () => {
      sendPromise = result.current.send('hello')
      await new Promise((resolve) => setTimeout(resolve, 0))
      result.current.abort()
      await sendPromise
    })

    expect(interruptChatSessionMock).toHaveBeenCalledWith('session-1')
    expect(result.current.status).toBe('idle')
  })

  it('stops streaming and persists only the user message when interrupted', async () => {
    let streamReleased = false
    async function* stream() {
      try {
        yield {
          data: JSON.stringify({
            event: 'interrupt',
            data: { reason: 'user' },
          }),
          event: '',
          id: '',
        }
        await new Promise(() => {})
      } finally {
        streamReleased = true
      }
    }
    sendChatStreamMock.mockResolvedValue(stream())

    const { result } = renderHook(() =>
      useChat({
        identityScopeKey: 'identity',
        persistMessages: true,
        sessionId: 'session-1',
      }),
    )

    await act(async () => {
      await result.current.send('hello')
    })

    expect(result.current.status).toBe('idle')
    expect(result.current.streamingParts).toEqual([])
    expect(result.current.messages).toHaveLength(1)
    expect(result.current.messages[0]?.role).toBe('user')
    expect(addMessageMock).toHaveBeenCalledTimes(1)
    expect(addMessageMock).toHaveBeenCalledWith('session-1', 'user', 'hello')
    expect(streamReleased).toBe(true)
  })

  it('requests backend interrupt but discards partial output on reset', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const encoder = new TextEncoder()
    sendChatStreamMock.mockImplementation((_request, signal: AbortSignal) =>
      fetchSse('/stream', {
        signal,
        fetch: vi.fn().mockResolvedValue(
          new Response(
            new ReadableStream<Uint8Array>({
              start(streamController) {
                controller = streamController
              },
            }),
            { headers: { 'Content-Type': 'text/event-stream' } },
          ),
        ),
      }),
    )

    const { result } = renderHook(() =>
      useChat({
        identityScopeKey: 'identity',
        persistMessages: false,
        sessionId: 'session-1',
      }),
    )

    let sendPromise!: Promise<void>
    await act(async () => {
      sendPromise = result.current.send('hello')
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            event: 'content_delta',
            data: 'partial',
          })}\n\n`,
        ),
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
      result.current.reset()
      await sendPromise
    })

    expect(interruptChatSessionMock).toHaveBeenCalledWith('session-1')
    expect(result.current.status).toBe('idle')
    expect(result.current.streamingParts).toEqual([])
    expect(result.current.messages).toEqual([])
  })

  it('requests backend interrupt when unmounted during a stream', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    sendChatStreamMock.mockImplementation((_request, signal: AbortSignal) =>
      fetchSse('/stream', {
        signal,
        fetch: vi.fn().mockResolvedValue(
          new Response(
            new ReadableStream<Uint8Array>({
              start(streamController) {
                controller = streamController
              },
            }),
            { headers: { 'Content-Type': 'text/event-stream' } },
          ),
        ),
      }),
    )

    const { result, unmount } = renderHook(() =>
      useChat({
        identityScopeKey: 'identity',
        persistMessages: false,
        sessionId: 'session-1',
      }),
    )

    let sendPromise!: Promise<void>
    await act(async () => {
      sendPromise = result.current.send('hello')
      await new Promise((resolve) => setTimeout(resolve, 0))
      unmount()
      controller.close()
      await sendPromise
    })

    expect(interruptChatSessionMock).toHaveBeenCalledWith('session-1')
  })

  it('steers new user input into an active stream without opening another stream', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const encoder = new TextEncoder()
    sendChatStreamMock.mockResolvedValue(
      fetchSse('/stream', {
        fetch: vi.fn().mockResolvedValue(
          new Response(
            new ReadableStream<Uint8Array>({
              start(streamController) {
                controller = streamController
              },
            }),
            { headers: { 'Content-Type': 'text/event-stream' } },
          ),
        ),
      }),
    )

    const { result } = renderHook(() =>
      useChat({
        identityScopeKey: 'identity',
        persistMessages: false,
        sessionId: 'session-1',
      }),
    )

    let sendPromise!: Promise<void>
    await act(async () => {
      sendPromise = result.current.send('hello')
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(result.current.status).toBe('streaming')

    await act(async () => {
      await result.current.send('follow up')
    })

    expect(sendChatStreamMock).toHaveBeenCalledTimes(1)
    expect(steerChatSessionMock).toHaveBeenCalledWith('session-1', {
      message: 'follow up',
    })
    expect(result.current.messages.map((message) => message.role)).toEqual([
      'user',
      'user',
    ])
    expect(result.current.messages[1]?.parts).toEqual([
      { type: 'text', text: 'follow up' },
    ])
    expect(result.current.messages[1]).toMatchObject({
      client_status: 'queued',
    })

    await act(async () => {
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({ event: 'response', data: 'answer' })}\n\n`,
        ),
      )
      controller.close()
      await sendPromise
    })
    expect(result.current.messages.map((message) => message.role)).toEqual([
      'user',
      'user',
      'assistant',
    ])
    expect(result.current.messages[1]?.parts).toEqual([
      { type: 'text', text: 'follow up' },
    ])
    expect(result.current.messages[1]?.client_status).toBeUndefined()
    expect(result.current.messages[2]?.parts).toEqual([
      { type: 'text', text: 'answer' },
    ])
  })

  it('keeps reasoning and tool timeline when aborted before content arrives', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const encoder = new TextEncoder()
    sendChatStreamMock.mockImplementation((_request, signal: AbortSignal) =>
      fetchSse('/stream', {
        signal,
        fetch: vi.fn().mockResolvedValue(
          new Response(
            new ReadableStream<Uint8Array>({
              start(streamController) {
                controller = streamController
              },
            }),
            { headers: { 'Content-Type': 'text/event-stream' } },
          ),
        ),
      }),
    )

    const { result } = renderHook(() =>
      useChat({
        identityScopeKey: 'identity',
        persistMessages: false,
        sessionId: 'session-1',
      }),
    )

    let sendPromise!: Promise<void>
    await act(async () => {
      sendPromise = result.current.send('hello')
      controller.enqueue(
        encoder.encode(
          [
            { event: 'reasoning_delta', data: 'checking' },
            { event: 'tool_call', data: 'search({})' },
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(''),
        ),
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
      result.current.abort()
      await sendPromise
    })

    expect(result.current.status).toBe('idle')
    expect(result.current.streamingParts).toEqual([])
    expect(result.current.messages[1]?.parts).toMatchObject([
      {
        is_running: false,
        reasoning: 'checking',
        type: 'reasoning',
      },
      {
        tool_name: 'search',
        tool_status: 'running',
        type: 'tool',
      },
    ])
  })
})
