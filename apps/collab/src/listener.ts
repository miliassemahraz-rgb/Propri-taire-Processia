import pg from 'pg';

export type NotificationHandler = (channel: string, payload: string) => void;

/**
 * Abonnement `LISTEN` sur une connexion dédiée, avec reconnexion automatique. Les notifications
 * émises pendant une coupure sont perdues : `onReconnect` permet de resynchroniser.
 */
export class NotificationListener {
  private client: pg.Client | null = null;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly url: string,
    private readonly channels: readonly string[],
    private readonly onNotification: NotificationHandler,
    private readonly onReconnect: () => void,
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect(false);
  }

  private async connect(reconnecting: boolean): Promise<void> {
    const client = new pg.Client({ connectionString: this.url });
    client.on('notification', (n) => {
      if (n.payload !== undefined) this.onNotification(n.channel, n.payload);
    });
    const lost = (): void => {
      if (this.client !== client) return;
      this.client = null;
      this.schedule();
    };
    client.on('error', (error) => {
      this.log(`Connexion LISTEN perdue : ${error.message}`);
      lost();
    });
    client.on('end', lost);
    await client.connect();
    for (const channel of this.channels) await client.query(`LISTEN ${channel}`);
    this.client = client;
    if (reconnecting) this.onReconnect();
  }

  private schedule(): void {
    if (this.stopped || this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect(true).catch((error: unknown) => {
        this.log(`Reconnexion LISTEN échouée : ${String(error)}`);
        this.schedule();
      });
    }, 1000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const client = this.client;
    this.client = null;
    if (client !== null) await client.end().catch(() => undefined);
  }
}
