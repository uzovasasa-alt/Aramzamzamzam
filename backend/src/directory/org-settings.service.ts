import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DEFAULT_ORG_SETTINGS, OrgSettings } from '../domain/rules';
import { Organization } from '../entities';

export type FullOrgSettings = OrgSettings & { telegramChatId?: string | null };

@Injectable()
export class OrgSettingsService {
  constructor(@InjectRepository(Organization) private readonly orgs: Repository<Organization>) {}

  async get(orgId: string): Promise<FullOrgSettings> {
    const org = await this.orgs.findOneBy({ id: orgId });
    return { ...DEFAULT_ORG_SETTINGS, ...((org?.settings ?? {}) as Partial<FullOrgSettings>) };
  }
}
