import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client';
import { PRISMA_SCHEMA } from './prisma-schema';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor() {
    super({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }, { schema: PRISMA_SCHEMA }) });
  }

  onModuleDestroy() {
    return this.$disconnect();
  }
}
