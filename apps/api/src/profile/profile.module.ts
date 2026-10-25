import { Module } from '@nestjs/common';
import { ProfileController } from './profile.controller';
import { ProfileService } from './profile.service';

/** Database only (no connectors), so the AI drafting code can use it without being able to send. */
@Module({ controllers: [ProfileController], providers: [ProfileService], exports: [ProfileService] })
export class ProfileModule {}
