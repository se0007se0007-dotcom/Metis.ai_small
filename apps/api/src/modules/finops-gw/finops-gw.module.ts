import { Module } from '@nestjs/common';
import { FinopsGwController } from './finops-gw.controller';

@Module({
  controllers: [FinopsGwController],
})
export class FinopsGwModule {}
