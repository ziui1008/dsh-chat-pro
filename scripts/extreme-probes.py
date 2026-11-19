#!/usr/bin/env python3
"""打一轮极端场景，确认工具循环在这些边界上不崩、不失礼。

需要本机 DSH 正在运行，默认打 http://127.0.0.1:60627；换端口用 WEBCHAT_URL。
脚本只在开发机跑，不进 CI（要真模型、真网络，且会计费）。

    python scripts/extreme-probes.py
"""

import json
import os
import socket
import threading
import time
import urllib.parse
import urllib.request

BASE = os.environ.get('WEBCHAT_URL', 'http://127.0.0.1:60627')
URL = f'{BASE}/webchat/anthropic/v1/messages'
TOOLS = [
    {'type': 'deepseek_web_search', 'name': 'deepseek_web_search'},
    {'type': 'deepseek_read_url', 'name': 'deepseek_read_url'},
]
ROUTE = {'provider': 'nume', 'model': 'gpt-6.2-sol', 'effort': 'low'}


def probe(label, body, timeout=240):
    data = json.dumps(body).encode('utf-8')
    request = urllib.request.Request(URL, data=data, headers={'content-type': 'application/json'})
    started = time.time()
    try:
        text = urllib.request.urlopen(request, timeout=timeout).read().decode('utf-8')
    except Exception as error:  # noqa: BLE001
        print(f'--- {label}: HTTP {error}')
        return
    events = [json.loads(line[6:]) for line in text.split('\n') if line.startswith('data: ')]
    blocks = [e['content_block']['type'] for e in events if e.get('type') == 'content_block_start']
    errors = [e['error'].get('message') for e in events if e.get('type') == 'error']
    print(f'--- {label}: {round(time.time() - started, 1)}s blocks={blocks} error={errors}')


def body(text, **extra):
    return {
        'model': 'gpt-6.2-sol',
        'system': 'x',
        'stream': True,
        'max_tokens': 300,
        'messages': [{'role': 'user', 'content': [{'type': 'text', 'text': text}]}],
        'thinking': {'type': 'disabled'},
        'tools': TOOLS,
        'dsh': ROUTE,
        **extra,
    }


def disconnect_early():
    payload = json.dumps(body('查一下成都今天天气')).encode('utf-8')
    parsed = urllib.parse.urlparse(BASE)
    request = (
        b'POST /webchat/anthropic/v1/messages HTTP/1.1\r\n'
        b'Host: ' + parsed.netloc.encode() + b'\r\n'
        b'Content-Type: application/json\r\n'
        b'Content-Length: ' + str(len(payload)).encode() + b'\r\n\r\n' + payload
    )
    sock = socket.create_connection((parsed.hostname, parsed.port or 80), timeout=10)
    sock.sendall(request)
    time.sleep(1.5)
    sock.close()
    print('--- 客户端提前断开：已关连接')


def main():
    probe('a. max_tokens=40 + 工具', body('查一下南京今天天气', max_tokens=40))
    probe('b. max_tokens=8', body('查一下杭州今天天气', max_tokens=8))
    probe('c. 未知供应商', body('你好', dsh={'provider': 'nope', 'model': 'x', 'effort': 'low'}))
    probe('d. 模型名不存在', body('你好', dsh={'provider': 'nume', 'model': 'no-such-model', 'effort': 'low'}))
    probe('e. 读内网地址', body('打开 http://127.0.0.1:60627/webchat/ 看看写了什么', max_tokens=200))

    threads = [threading.Thread(target=probe, args=('f. 并发', body('查一下西安今天天气', max_tokens=200))) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    disconnect_early()
    time.sleep(3)
    probe('g. 断开后健康检查', body('只回复两个字：收到', tools=[], max_tokens=40))

    for index in range(5):
        probe(f'h{index + 1}. 连发', body('只回复两个字：收到', tools=[], max_tokens=40))


if __name__ == '__main__':
    main()
