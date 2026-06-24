import { Controller, Post, Get, Body, Req, Res } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiProperty, ApiBearerAuth } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsString, IsOptional } from 'class-validator';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { Public } from '../../common/decorators';

class LoginDto {
  @ApiProperty({ example: 'admin@metis.ai' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'metis1234' })
  @IsNotEmpty()
  @IsString()
  password!: string;
}

class RefreshDto {
  // Optional: web clients rely on the httpOnly `metis_refresh` cookie, so the
  // body may be empty. Backward-compatible for clients that still send it.
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  refreshToken?: string;
}

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('login')
  @ApiOperation({ summary: 'Login with email/password' })
  @ApiResponse({ status: 200, description: 'Login successful' })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.authService.login(dto.email, dto.password);

    // H-7: set httpOnly cookies (access on '/', refresh scoped to '/v1/auth').
    res.cookie('metis_access', result.accessToken, this.authService.getAccessCookieConfig());
    res.cookie('metis_refresh', result.refreshToken, this.authService.getRefreshCookieConfig());

    // Response shape preserved: tokens still returned in body for backward compat.
    return result;
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user info from JWT' })
  @ApiResponse({ status: 200, description: 'Current user info' })
  async me(@Req() req: any) {
    return {
      userId: req.user.userId,
      email: req.user.email,
      tenantId: req.user.tenantId,
      role: req.user.role,
    };
  }

  @Public()
  @Post('refresh')
  @ApiOperation({ summary: 'Refresh access token' })
  @ApiResponse({ status: 200, description: 'Token refreshed' })
  @ApiResponse({ status: 401, description: 'Invalid refresh token' })
  async refresh(
    @Body() dto: RefreshDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Accept the refresh token from the body (backward compat) or the
    // httpOnly `metis_refresh` cookie (preferred for web clients).
    const cookieToken = (req as any).cookies?.metis_refresh as string | undefined;
    const result = await this.authService.refresh(dto?.refreshToken || cookieToken || '');

    res.cookie('metis_access', result.accessToken, this.authService.getAccessCookieConfig());
    res.cookie('metis_refresh', result.refreshToken, this.authService.getRefreshCookieConfig());

    // Response shape preserved.
    return result;
  }

  @Public()
  @Post('logout')
  @ApiOperation({ summary: 'Logout — revoke refresh token and clear auth cookies' })
  @ApiResponse({ status: 200, description: 'Logged out' })
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    // M-1: identify the user from the refresh cookie (if any) and revoke its jti.
    const cookieToken = (req as any).cookies?.metis_refresh as string | undefined;
    const userId = (req as any).user?.userId as string | undefined;
    await this.authService.revokeRefreshForUser(userId);
    if (cookieToken) {
      await this.authService.revokeRefreshFromToken(cookieToken);
    }

    res.clearCookie('metis_access', { path: '/' });
    res.clearCookie('metis_refresh', { path: '/api/auth' });
    return { success: true };
  }
}
