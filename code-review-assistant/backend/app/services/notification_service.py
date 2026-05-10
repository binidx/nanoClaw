"""
Notification service — sends review results to configured channels.
Currently supports Feishu webhook.
"""

import logging

import httpx

logger = logging.getLogger("code-review.notify")


async def send_feishu_webhook(webhook_url: str, repo_name: str, review_summary: str, passed: bool) -> bool:
    """Send a review notification to a Feishu group via webhook bot."""
    status_emoji = "✅" if passed else "❌"
    status_text = "通过" if passed else "不通过"

    card = {
        "msg_type": "interactive",
        "card": {
            "header": {
                "title": {
                    "tag": "plain_text",
                    "content": f"{status_emoji} 代码审查结果 - {repo_name}",
                },
                "template": "green" if passed else "red",
            },
            "elements": [
                {
                    "tag": "div",
                    "text": {
                        "tag": "lark_md",
                        "content": f"**仓库:** {repo_name}\n**结果:** {status_text}\n**摘要:** {review_summary}",
                    },
                },
            ],
        },
    }

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(webhook_url, json=card)
            if resp.status_code == 200:
                logger.info("Feishu notification sent for %s", repo_name)
                return True
            logger.warning("Feishu webhook returned %s: %s", resp.status_code, resp.text[:200])
    except Exception as e:
        logger.error("Feishu notification failed: %s", e)

    return False


async def send_notifications(notifications: list, repo_name: str, review_summary: str, passed: bool):
    """Send review result to all enabled notification channels of a repo."""
    for notif in notifications:
        if not notif.enabled:
            continue
        if notif.type == "feishu":
            await send_feishu_webhook(notif.target, repo_name, review_summary, passed)
        else:
            logger.warning("Unknown notification type: %s", notif.type)
