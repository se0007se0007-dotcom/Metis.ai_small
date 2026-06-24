import { Global, Module, OnModuleDestroy } from '@nestjs/common';
import { prisma } from '@metis/database';

export const PRISMA_TOKEN = 'PRISMA_SERVICE';

@Global()
@Module({
  providers: [
    {
      provide: PRISMA_TOKEN,
      useValue: prisma,
    },
  ],
  exports: [PRISMA_TOKEN],
})
export class DatabaseModule implements OnModuleDestroy {
  async onModuleDestroy() {
    await prisma.$disconnect();
  }
}
