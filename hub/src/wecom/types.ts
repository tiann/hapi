/**
 * WeCom aibot WS types.
 *
 * Re-exported from the official @wecom/aibot-node-sdk. The only reason this
 * file still exists is that the SDK's TemplateCardEventData declares
 * event_key and task_id as flat fields on the event object, but the live
 * wire nests them under event.template_card_event.*. callbacks.ts reads
 * the nested path first and falls back to the flat one; see the extractor
 * there.
 */

export type {
    WsFrame,
    TextMessage,
    EventMessage,
    EventMessageWith,
    TemplateCardEventData,
    TemplateCard,
    TemplateCardButton,
    TemplateCardMainTitle,
    TemplateCardAction,
    SendMsgBody,
    SendMarkdownMsgBody,
    SendTemplateCardMsgBody,
    UpdateTemplateCardBody
} from '@wecom/aibot-node-sdk'
