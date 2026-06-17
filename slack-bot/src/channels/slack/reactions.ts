const SLACK_REACTION_NAMES: Record<string, string> = {
  '✅': 'white_check_mark',
  '❌': 'x',
  '⏹': 'stop_button',
  '⏹️': 'stop_button',
  '🤔': 'thinking_face',
  '⚙': 'gear',
  '⚙️': 'gear',
  '🔄': 'arrows_counterclockwise',
  '📋': 'clipboard',
  '👀': 'eyes',
  '⏳': 'hourglass_flowing_sand',
  '⚠': 'warning',
  '⚠️': 'warning',
  '🚨': 'rotating_light',
  '📝': 'memo',
  '🤖': 'robot_face',
  '🏁': 'checkered_flag',
};

export function normalizeSlackReactionName(reaction: string): string {
  const trimmed = reaction.trim();
  const unwrapped = trimmed.replace(/^:+|:+$/g, '');
  return SLACK_REACTION_NAMES[unwrapped] ?? SLACK_REACTION_NAMES[unwrapped.replace(/\uFE0F/g, '')] ?? unwrapped;
}
