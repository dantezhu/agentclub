from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CHAT_TEMPLATE = ROOT / "src" / "agentclub" / "templates" / "chat.html"
CHAT_JS = ROOT / "src" / "agentclub" / "static" / "js" / "chat.js"


def test_chat_page_loads_pinned_dompurify_before_chat_bundle():
    html = CHAT_TEMPLATE.read_text()

    assert "https://cdn.jsdelivr.net/npm/dompurify@3.4.6/dist/purify.min.js" in html
    assert "dompurify@3.4.6" in html
    assert "dompurify@" in html
    assert html.index("dompurify@3.4.6") < html.index('/static/js/chat.js')


def test_markdown_raw_html_is_escaped_before_rendering():
    js = CHAT_JS.read_text()

    renderer_start = js.index("marked.use({")
    renderer_end = js.index("connectSocket();", renderer_start)
    renderer = js[renderer_start:renderer_end]

    assert "html(token)" in renderer
    assert "return escHtml" in renderer


def test_message_markdown_is_sanitized_after_mentions_are_rendered():
    js = CHAT_JS.read_text()

    render_start = js.index("function renderMarkdown(text)")
    render_end = js.index("function renderAudioPlayer", render_start)
    render_block = js[render_start:render_end]

    assert "html = html.replace" in render_block
    assert "return sanitizeMessageHtml(html);" in render_block


def test_sanitizer_preserves_mentions_and_drops_inline_styles():
    js = CHAT_JS.read_text()

    sanitizer_start = js.index("function sanitizeMessageHtml(html)")
    sanitizer_end = js.index("function renderAudioPlayer", sanitizer_start)
    sanitizer = js[sanitizer_start:sanitizer_end]

    assert "window.DOMPurify.sanitize" in sanitizer
    assert "USE_PROFILES: { html: true }" in sanitizer
    assert "ADD_ATTR: ['data-user-id']" in sanitizer
    assert "FORBID_ATTR: ['style']" in sanitizer
    assert "return escHtml(html);" in sanitizer
