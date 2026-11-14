// A topic is one button or dropdown entry on a panel. Any setting left empty on a topic
// falls back to the panel's, so a plain panel works with zero per-topic configuration.
const { q } = require('./db');

const MAX_QUESTIONS = 5; // questions per form, text and multiple choice together
const MAX_CHOICE_QUESTIONS = 4; // multiple choice ones are dropdown rows, and one row is for the button
const MAX_QUESTION_LENGTH = 45; // a Discord form label holds at most 45 characters
const MAX_OPTIONS = 25; // options in one dropdown
const MAX_OPTION_LENGTH = 100;
const MAX_TOPICS = 25; // one dropdown, or five rows of five buttons

const BUTTON_STYLES = ['primary', 'secondary', 'success', 'danger'];
const STYLE_ALIASES = {
  blue: 'primary', primary: 'primary', purple: 'primary', blurple: 'primary',
  gray: 'secondary', grey: 'secondary', secondary: 'secondary',
  green: 'success', success: 'success',
  red: 'danger', danger: 'danger',
};

/** "blue" -> "primary". Returns undefined for an unknown word, null for empty. */
function normalizeStyle(text) {
  const word = String(text ?? '').trim().toLowerCase();
  if (!word || word === 'none' || word === 'default') return null;
  return STYLE_ALIASES[word];
}

/**
 * "Platform? [PC, Console, Mobile]" is a dropdown question; anything else is a free-text one.
 * Returns { label, options } where options is null for free text.
 */
function parseQuestion(raw) {
  const text = String(raw);
  const match = /^(.*?)\s*\[(.+)\]\s*$/.exec(text);
  if (!match) return { label: text, options: null };
  const options = [...new Set(match[2].split(',').map((s) => s.trim()).filter(Boolean))];
  if (options.length < 2) return { label: text, options: null };
  return { label: match[1].trim() || 'Choose one', options: options.slice(0, MAX_OPTIONS) };
}

/** The raw question strings of a topic, or of its panel when the topic has none of its own. */
function questionsOf(topic, panel = null) {
  const parse = (json) => {
    if (!json) return [];
    try {
      const parsed = JSON.parse(json);
      return Array.isArray(parsed)
        ? parsed.map(String).filter(Boolean).slice(0, MAX_QUESTIONS)
        : [];
    } catch {
      return [];
    }
  };
  const own = parse(topic?.questions);
  return own.length ? own : parse(panel?.questions);
}

/** Questions split into the dropdown ones and the free-text ones, each in its original order. */
function splitQuestions(topic, panel = null) {
  const all = questionsOf(topic, panel).map(parseQuestion);
  return { all, choices: all.filter((x) => x.options), texts: all.filter((x) => !x.options) };
}

/**
 * Parses "Question one | Question two | Platform? [PC, Console]" (a new line also separates).
 * Returns { questions } (the raw strings) or { error }.
 */
function parseQuestions(raw) {
  const questions = String(raw ?? '')
    .split(/[|\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (questions.length > MAX_QUESTIONS) {
    return { error: `You can ask at most ${MAX_QUESTIONS} questions.` };
  }
  const parsed = questions.map(parseQuestion);
  const long = parsed.find((p) => p.label.length > MAX_QUESTION_LENGTH);
  if (long) {
    return {
      error: `Each question can be at most ${MAX_QUESTION_LENGTH} characters (Discord's limit for form labels). Shorten: "${long.label}"`,
    };
  }
  const tooLongOption = parsed.flatMap((p) => p.options ?? []).find((o) => o.length > MAX_OPTION_LENGTH);
  if (tooLongOption) return { error: `A dropdown option can be at most ${MAX_OPTION_LENGTH} characters: "${tooLongOption}"` };
  if (parsed.filter((p) => p.options).length > MAX_CHOICE_QUESTIONS) {
    return { error: `At most ${MAX_CHOICE_QUESTIONS} questions can be dropdowns.` };
  }
  return { questions };
}

// A unicode emoji, or a custom one like <:name:123456789012345678>
const EMOJI = /^(?:<a?:\w{2,32}:\d{17,20}>|\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|\p{Emoji_Modifier})*)$/u;
const isEmoji = (text) => EMOJI.test(String(text).trim());

/** Effective settings for a ticket opened from `topic` on `panel`. */
function resolve(panel, topic) {
  return {
    kind: topic?.kind ?? 'ticket',
    staffRoleId: topic?.staff_role_id ?? panel.staff_role_id,
    parentId: topic?.category_id ?? panel.category_id ?? null,
    transcriptChannelId: topic?.transcript_channel_id ?? panel.transcript_channel_id ?? null,
    maxTickets: topic?.max_tickets ?? panel.max_tickets,
    message: topic?.ticket_message ?? panel.ticket_message ?? null,
    acceptRoleId: topic?.accept_role_id ?? null,
  };
}

/** Whether clicking this topic must ask something before anything is created. */
function needsForm(panel, topic) {
  return (
    topic.kind === 'application' ||
    questionsOf(topic, panel).length > 0 ||
    panel.type === 'form' ||
    Boolean(panel.form_enabled)
  );
}

/** A full row for insertTopic: callers pass only what they care about. */
function newTopic(fields) {
  return {
    position: 0,
    emoji: null,
    description: null,
    kind: 'ticket',
    staff_role_id: null,
    category_id: null,
    transcript_channel_id: null,
    max_tickets: null,
    questions: null,
    ticket_message: null,
    accept_role_id: null,
    button_style: null,
    ...fields,
  };
}

const forPanel = (panelId) => q.topicsByPanel.all(panelId);

module.exports = {
  MAX_QUESTIONS,
  MAX_CHOICE_QUESTIONS,
  MAX_QUESTION_LENGTH,
  MAX_TOPICS,
  BUTTON_STYLES,
  normalizeStyle,
  parseQuestion,
  questionsOf,
  splitQuestions,
  parseQuestions,
  isEmoji,
  resolve,
  needsForm,
  newTopic,
  forPanel,
};
