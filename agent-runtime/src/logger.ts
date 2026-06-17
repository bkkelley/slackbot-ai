export class Logger {
  constructor(private name: string) {}

  info(msg: string, data?: object): void {
    console.log(JSON.stringify({ level: 'info', name: this.name, msg, ...data, ts: new Date().toISOString() }));
  }

  warn(msg: string, data?: object): void {
    console.log(JSON.stringify({ level: 'warn', name: this.name, msg, ...data, ts: new Date().toISOString() }));
  }

  error(msg: string, data?: object): void {
    console.error(JSON.stringify({ level: 'error', name: this.name, msg, ...data, ts: new Date().toISOString() }));
  }

  debug(msg: string, data?: object): void {
    if (process.env.DEBUG) {
      console.log(JSON.stringify({ level: 'debug', name: this.name, msg, ...data, ts: new Date().toISOString() }));
    }
  }
}
