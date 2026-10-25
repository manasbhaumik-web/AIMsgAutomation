import { Body, Controller, Get, Put } from '@nestjs/common';
import { CurrentUser, dbCtx } from '../auth/guards';
import { AuthUser } from '../auth/token.service';
import { ZodPipe } from '../common/zod.pipe';
import { Profile, ProfileService, profileSchema } from './profile.service';

@Controller()
export class ProfileController {
  constructor(private readonly profiles: ProfileService) {}

  @Get('me/profile')
  get(@CurrentUser() u: AuthUser) {
    return this.profiles.get(dbCtx(u));
  }

  /** Replaces the whole profile. Fields left out return to their defaults. */
  @Put('me/profile')
  save(@CurrentUser() u: AuthUser, @Body(new ZodPipe(profileSchema)) b: Profile) {
    return this.profiles.save(dbCtx(u), b);
  }
}
