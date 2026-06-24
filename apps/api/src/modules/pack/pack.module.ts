import { Module } from '@nestjs/common';
import { PackController } from './pack.controller';
import { InstallationController } from './installation.controller';
import { CertificationController } from './certification.controller';
import { PackAdminController } from './admin.controller';
import { JobController } from './job.controller';
import { PackService } from './pack.service';
import { CertificationService } from './certification.service';
import { PackImportQueueProvider } from './queue.provider';

@Module({
  controllers: [
    PackController,
    InstallationController,
    CertificationController,
    PackAdminController,
    JobController,
  ],
  providers: [PackService, CertificationService, PackImportQueueProvider],
  exports: [PackService, CertificationService],
})
export class PackModule {}
