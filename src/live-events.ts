import { DynamicModule, Inject, Injectable, Logger, MessageEvent, Module, OnModuleDestroy } from '@nestjs/common';
import Redis, { RedisOptions } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { filter, interval, map, merge, Observable, of, Subject } from 'rxjs';

export interface LiveEvent<T = unknown> {
    id: string;
    type: string;
    service: string;
    data: T;
    ts: string;
}

export interface LiveEventsOptions {
    /** The publishing service, e.g. `commerce`. */
    service: string;
    redis: RedisOptions;
    /** Keep-alive interval for idle streams, so proxies do not close them. */
    pingIntervalMs?: number;
}

export const LIVE_EVENTS_OPTIONS = Symbol('LIVE_EVENTS_OPTIONS');

/**
 * Publishes UI events to Redis and streams them back to browsers over SSE.
 * Every instance subscribes, so an event published on one instance reaches a
 * browser connected to any other.
 *
 * Keys are `live:<service>:<scope>`, where a scope names a tenant and an
 * audience, such as `northside:customer:12` or `northside:catalog`.
 */
@Injectable()
export class LiveEventsService implements OnModuleDestroy {
    private readonly publisher: Redis;
    private readonly subscriber: Redis;
    private readonly incoming = new Subject<{ key: string; event: LiveEvent }>();
    private readonly logger = new Logger(LiveEventsService.name);

    constructor(@Inject(LIVE_EVENTS_OPTIONS) private readonly options: LiveEventsOptions) {
        this.publisher = new Redis(options.redis);
        this.subscriber = new Redis({ ...options.redis, enableReadyCheck: false });
        for (const client of [this.publisher, this.subscriber]) {
            client.on('error', error => this.logger.warn(`Redis: ${error.message}`));
        }
        void this.subscriber.psubscribe(`live:${options.service}:*`);
        this.subscriber.on('pmessage', (_pattern, key, message) => {
            try {
                this.incoming.next({ key, event: JSON.parse(message) as LiveEvent });
            } catch {
                // A malformed message is dropped rather than ending every stream.
            }
        });
    }

    async publish<T>(scope: string, type: string, data: T): Promise<LiveEvent<T>> {
        return this.publishAs(this.options.service, scope, type, data);
    }

    /** Publishes on another service's streams, for events its browsers follow, such as the studio's draft changes on commerce's dashboard stream. */
    async publishAs<T>(service: string, scope: string, type: string, data: T): Promise<LiveEvent<T>> {
        const event: LiveEvent<T> = {
            id: randomUUID(),
            type,
            service: this.options.service,
            data,
            ts: new Date().toISOString(),
        };
        await this.publisher.publish(`live:${service}:${scope}`, JSON.stringify(event));
        return event;
    }

    /** An SSE stream of the given scopes, opening with `ready` and kept alive with `ping`. */
    stream(scopes: string[]): Observable<MessageEvent> {
        const keys = new Set(scopes.map(scope => this.key(scope)));
        const events = this.incoming.pipe(
            filter(({ key }) => keys.has(key)),
            map(({ event }): MessageEvent => ({ id: event.id, type: event.type, data: event })),
        );
        const pings = interval(this.options.pingIntervalMs ?? 15_000).pipe(
            map((): MessageEvent => ({ type: 'ping', data: { ts: new Date().toISOString() } })),
        );
        const ready = of<MessageEvent>({ type: 'ready', data: { service: this.options.service } });
        return merge(ready, events, pings);
    }

    async onModuleDestroy() {
        this.incoming.complete();
        await Promise.allSettled([this.subscriber.quit(), this.publisher.quit()]);
    }

    private key(scope: string) {
        return `live:${this.options.service}:${scope}`;
    }
}

@Module({})
export class LiveEventsModule {
    static forRoot(options: LiveEventsOptions): DynamicModule {
        return {
            module: LiveEventsModule,
            global: true,
            providers: [{ provide: LIVE_EVENTS_OPTIONS, useValue: options }, LiveEventsService],
            exports: [LiveEventsService],
        };
    }
}
