use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::MagicIntentBundleBuilder;

declare_id!("CAKp5hPGXYZVd3Hws51VtmvDHXeH2NpU1a12dMspCTrs");

pub const GAME_SEED: &[u8] = b"tap-blitz";
/// A round lasts 30 seconds of real-time tapping.
pub const ROUND_SECONDS: i64 = 30;

#[ephemeral]
#[program]
pub mod tap_blitz {
    use super::*;

    /// Create the player's game account (base layer).
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let game = &mut ctx.accounts.game;
        game.player = ctx.accounts.player.key();
        game.taps = 0;
        game.best = 0;
        game.round_start = 0;
        game.round_active = false;
        game.bump = ctx.bumps.game;
        msg!("Tap Blitz game created for {}", game.player);
        Ok(())
    }

    /// Start a new 30-second round. Resets the tap counter.
    /// Intended to run on the Ephemeral Rollup after delegation.
    pub fn start_round(ctx: Context<Play>) -> Result<()> {
        let game = &mut ctx.accounts.game;
        require!(game.player == ctx.accounts.player.key(), TapBlitzError::NotPlayer);
        let now = Clock::get()?.unix_timestamp;
        game.taps = 0;
        game.round_start = now;
        game.round_active = true;
        msg!("Round started at {} for {}", now, game.player);
        Ok(())
    }

    /// One tap. Only counts while the round is active and inside the 30s window.
    pub fn tap(ctx: Context<Play>) -> Result<()> {
        let game = &mut ctx.accounts.game;
        require!(game.player == ctx.accounts.player.key(), TapBlitzError::NotPlayer);
        require!(game.round_active, TapBlitzError::RoundNotActive);
        let now = Clock::get()?.unix_timestamp;
        require!(
            now < game.round_start + ROUND_SECONDS,
            TapBlitzError::RoundOver
        );
        game.taps = game.taps.checked_add(1).ok_or(TapBlitzError::Overflow)?;
        Ok(())
    }

    /// End the round, record the best score, and commit + undelegate the
    /// account back to the Solana base layer in one ER transaction.
    pub fn finish_round(ctx: Context<FinishRound>) -> Result<()> {
        let game = &mut ctx.accounts.game;
        require!(game.player == ctx.accounts.payer.key(), TapBlitzError::NotPlayer);
        require!(game.round_active, TapBlitzError::RoundNotActive);
        if game.taps > game.best {
            game.best = game.taps;
        }
        game.round_active = false;
        msg!(
            "Round finished: {} taps (best {})",
            game.taps,
            game.best
        );
        // Serialize the updated account, then commit + undelegate.
        game.exit(&crate::ID)?;
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.game.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    /// Delegate the game account to the Ephemeral Rollup.
    /// Pass the target validator as the first remaining account to pin a region.
    pub fn delegate(ctx: Context<DelegateInput>) -> Result<()> {
        ctx.accounts.delegate_pda(
            &ctx.accounts.payer,
            &[GAME_SEED, ctx.accounts.payer.key().as_ref()],
            DelegateConfig {
                validator: ctx.remaining_accounts.first().map(|acc| acc.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// Undelegate without finalizing (cleanup path).
    pub fn undelegate(ctx: Context<FinishRound>) -> Result<()> {
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.game.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init_if_needed,
        payer = player,
        space = 8 + 32 + 8 + 8 + 8 + 1 + 1,
        seeds = [GAME_SEED, player.key().as_ref()],
        bump
    )]
    pub game: Account<'info, Game>,
    #[account(mut)]
    pub player: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// Playing a round: start_round / tap.
#[derive(Accounts)]
pub struct Play<'info> {
    #[account(mut, seeds = [GAME_SEED, player.key().as_ref()], bump = game.bump)]
    pub game: Account<'info, Game>,
    pub player: Signer<'info>,
}

/// Finish / undelegate: needs the MagicBlock commit accounts.
#[commit]
#[derive(Accounts)]
pub struct FinishRound<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [GAME_SEED, payer.key().as_ref()], bump = game.bump)]
    pub game: Account<'info, Game>,
}

/// Add delegate function to the context.
#[delegate]
#[derive(Accounts)]
pub struct DelegateInput<'info> {
    pub payer: Signer<'info>,
    /// CHECK: the game PDA to delegate.
    #[account(mut, del)]
    pub pda: UncheckedAccount<'info>,
}

#[account]
pub struct Game {
    pub player: Pubkey,
    pub taps: u64,
    pub best: u64,
    pub round_start: i64,
    pub round_active: bool,
    pub bump: u8,
}

#[error_code]
pub enum TapBlitzError {
    #[msg("Only the game owner can play this round")]
    NotPlayer,
    #[msg("No round is active — press Start round first")]
    RoundNotActive,
    #[msg("The 30-second round is over")]
    RoundOver,
    #[msg("Tap counter overflow")]
    Overflow,
}
