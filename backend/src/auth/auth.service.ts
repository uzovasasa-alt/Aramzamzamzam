import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { Repository } from 'typeorm';
import { Organization, User } from '../entities';
import type { AccessPayload } from '../common/auth';

interface RefreshPayload {
  sub: string;
  ver: number;
  typ: 'refresh';
}

@Injectable()
export class AuthService {
  constructor(
    private readonly jwt: JwtService,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Organization) private readonly orgs: Repository<Organization>,
  ) {}

  async login(login: string, password: string) {
    const user = await this.users
      .createQueryBuilder('u')
      .addSelect('u.passwordHash')
      .where('lower(u.login) = lower(:login)', { login: login.trim() })
      .getOne();
    // Одинаковое сообщение для «нет пользователя» и «неверный пароль» — не подсказываем злоумышленнику
    if (!user || !user.isActive || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new UnauthorizedException('Неверный логин или пароль');
    }
    if (user.orgId) {
      const org = await this.orgs.findOneBy({ id: user.orgId });
      if (!org?.isActive) throw new UnauthorizedException('Хозяйство отключено');
    }
    return this.issue(user);
  }

  async refresh(refreshToken: string) {
    let p: RefreshPayload;
    try {
      p = this.jwt.verify<RefreshPayload>(refreshToken, { secret: process.env.JWT_REFRESH_SECRET });
    } catch {
      throw new UnauthorizedException('Сессия истекла, войдите заново');
    }
    const user = await this.users.findOneBy({ id: p.sub });
    // tokenVersion увеличивается при смене пароля/блокировке — старые refresh-токены перестают работать
    if (p.typ !== 'refresh' || !user || !user.isActive || user.tokenVersion !== p.ver) {
      throw new UnauthorizedException('Сессия отозвана');
    }
    return this.issue(user);
  }

  private issue(user: User) {
    const access: AccessPayload = { sub: user.id, org: user.orgId, role: user.role, name: user.fullName, typ: 'access' };
    const refresh: RefreshPayload = { sub: user.id, ver: user.tokenVersion, typ: 'refresh' };
    return {
      accessToken: this.jwt.sign(access, {
        secret: process.env.JWT_ACCESS_SECRET,
        expiresIn: process.env.JWT_ACCESS_TTL ?? '1h',
      }),
      refreshToken: this.jwt.sign(refresh, {
        secret: process.env.JWT_REFRESH_SECRET,
        expiresIn: process.env.JWT_REFRESH_TTL ?? '60d',
      }),
      user: { id: user.id, orgId: user.orgId, role: user.role, fullName: user.fullName, login: user.login },
    };
  }

  static hash(password: string) {
    return bcrypt.hash(password, 10);
  }
}
