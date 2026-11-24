/**
 * Аутентификация и авторизация без passport — проще понять и отладить.
 *  - JwtAuthGuard проверяет access-токен (заголовок Authorization: Bearer ... или ?access_token= для SSE)
 *  - @Roles('ADMIN', 'MODERATOR') ограничивает доступ по роли
 *  - @Public() открывает эндпоинт без токена
 *  - @CurrentUser() достаёт пользователя из запроса
 * Каждый запрос автоматически «привязан» к хозяйству пользователя (orgId) — мультиарендность.
 */
import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Role } from '../entities';

export interface AuthUser {
  id: string;
  orgId: string | null;
  role: Role;
  fullName: string;
}

export interface AccessPayload {
  sub: string;
  org: string | null;
  role: Role;
  name: string;
  typ: 'access';
}

export const IS_PUBLIC = 'isPublic';
export const ROLES = 'roles';
export const Public = () => SetMetadata(IS_PUBLIC, true);
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest().user;
});

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService, private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers?.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : (req.query?.access_token as string | undefined);
    if (!token) throw new UnauthorizedException('Нет токена');

    let payload: AccessPayload;
    try {
      payload = this.jwt.verify<AccessPayload>(token, { secret: process.env.JWT_ACCESS_SECRET });
    } catch {
      throw new UnauthorizedException('Токен недействителен или истёк');
    }
    if (payload.typ !== 'access') throw new UnauthorizedException('Неверный тип токена');
    const user: AuthUser = { id: payload.sub, orgId: payload.org, role: payload.role, fullName: payload.name };
    req.user = user;

    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES, targets);
    if (roles?.length && !roles.includes(user.role) && user.role !== 'SUPERADMIN') {
      throw new ForbiddenException('Недостаточно прав');
    }
    return true;
  }
}

/**
 * Хозяйство, в рамках которого выполняется запрос.
 * Обычные пользователи — всегда своё хозяйство; суперадмин выбирает хозяйство заголовком X-Org-Id.
 */
export function orgOf(user: AuthUser, explicitOrgId?: string): string {
  if (user.role === 'SUPERADMIN') {
    if (!explicitOrgId) throw new ForbiddenException('Выберите хозяйство (заголовок X-Org-Id)');
    return explicitOrgId;
  }
  if (!user.orgId) throw new ForbiddenException('Пользователь не привязан к хозяйству');
  return user.orgId;
}

/** @OrgId() — id хозяйства текущего запроса */
export const OrgId = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest();
  return orgOf(req.user, req.headers?.['x-org-id']);
});
