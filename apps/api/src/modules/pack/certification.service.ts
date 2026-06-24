/**
 * Certification Service
 * Manages pack version certifications and certification queries.
 */
import { Injectable, Inject, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaClient } from '@metis/database';
import { PRISMA_TOKEN } from '../database.module';

export interface CreateCertificationDto {
  packVersionId: string;
  level: string;
  notes?: string;
}

@Injectable()
export class CertificationService {
  constructor(@Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient) {}

  /**
   * Create a new certification for a pack version.
   * Only VALIDATED or CERTIFIED versions can be (re-)certified.
   */
  async certify(dto: CreateCertificationDto, certifierId: string) {
    const version = await this.prisma.packVersion.findUnique({
      where: { id: dto.packVersionId },
    });

    if (!version) {
      throw new NotFoundException('Pack version not found');
    }

    const allowedStatuses = ['VALIDATED', 'CERTIFIED'];
    if (!allowedStatuses.includes(version.status)) {
      throw new BadRequestException(
        `Cannot certify pack version in status "${version.status}". Must be VALIDATED or CERTIFIED.`,
      );
    }

    const certification = await this.prisma.certification.create({
      data: {
        packVersionId: dto.packVersionId,
        level: dto.level,
        findingsJson: {
          notes: dto.notes,
          certifiedAt: new Date().toISOString(),
        },
      },
    });

    // Transition to CERTIFIED if currently VALIDATED
    if (version.status === 'VALIDATED') {
      await this.prisma.packVersion.update({
        where: { id: dto.packVersionId },
        data: { status: 'CERTIFIED' },
      });
    }

    return certification;
  }

  /**
   * List certifications for a specific pack version.
   */
  async listCertifications(packVersionId: string) {
    return this.prisma.certification.findMany({
      where: { packVersionId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Get certification details by ID.
   */
  async getCertification(certificationId: string) {
    const cert = await this.prisma.certification.findUnique({
      where: { id: certificationId },
      include: { packVersion: { include: { pack: true } } },
    });
    if (!cert) throw new NotFoundException('Certification not found');
    return cert;
  }

  /**
   * Revoke a certification (deletes record, optionally downgrades status).
   */
  async revokeCertification(certificationId: string) {
    const cert = await this.prisma.certification.findUnique({
      where: { id: certificationId },
      include: { packVersion: true },
    });

    if (!cert) throw new NotFoundException('Certification not found');

    await this.prisma.certification.delete({ where: { id: certificationId } });

    // Check if there are remaining certifications
    const remaining = await this.prisma.certification.count({
      where: { packVersionId: cert.packVersionId },
    });

    // If no certifications remain and version is CERTIFIED, revert to VALIDATED
    if (remaining === 0 && cert.packVersion.status === 'CERTIFIED') {
      await this.prisma.packVersion.update({
        where: { id: cert.packVersionId },
        data: { status: 'VALIDATED' },
      });
    }

    return { success: true, remainingCertifications: remaining };
  }
}
