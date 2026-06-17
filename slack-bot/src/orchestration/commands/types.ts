export interface CommandContext {
  text: string;
  user: string;
  channel: string;
  thread_ts?: string;
  ts: string;
  say: any;
}
