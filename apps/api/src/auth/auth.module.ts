import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { OidcService } from './oidc.service';
import { TokenService } from './token.service';
import { AuthGuard, RolesGuard, SessionLiveness } from './guards';

@Module({
  controllers: [AuthController],
  providers: [AuthService, OidcService, TokenService, SessionLiveness, AuthGuard, RolesGuard],
  exports: [TokenService, AuthService, SessionLiveness, AuthGuard, RolesGuard],
})
export class AuthModule {}
