import { actorSchema, type Actor } from '../../contract';
import { BadRequestException, Body, Controller, Headers, HttpCode, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { InternalKeyGuard } from '../internal/internal-key.guard';
import { StudioGraph } from './graph.service';

const PLATFORM: Actor = { kind: 'platform', name: 'Platform' };
const requestSchema = z.object({ query: z.string().min(1), variables: z.record(z.string(), z.unknown()).nullish(), operationName: z.string().nullish() });

function principalOf(header: string | undefined): Actor {
  if (!header) return PLATFORM;
  try {
    return actorSchema.parse(JSON.parse(Buffer.from(header, 'base64url').toString('utf8')));
  } catch {
    throw new BadRequestException('x-studio-principal is not a valid principal');
  }
}

@Controller('internal/studio/graphql')
@UseGuards(InternalKeyGuard)
export class GraphController {
  constructor(private readonly graph: StudioGraph) {}

  @Post()
  @HttpCode(200)
  execute(@Body() body: unknown, @Headers('x-studio-store') store: string | undefined, @Headers('x-studio-principal') principal: string | undefined) {
    const request = requestSchema.safeParse(body);
    if (!request.success) throw new BadRequestException('Send a GraphQL query');
    if (store && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(store)) throw new BadRequestException('x-studio-store names the store');
    return this.graph.execute(request.data, { store: store ?? null, actor: principalOf(principal), activity: [] });
  }
}
