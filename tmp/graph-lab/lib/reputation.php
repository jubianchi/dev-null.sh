<?php

// Gives the lab's accounts a good reputation, so their commits are approved and everyone sees them, and has them accept
// the commit rules, so the composer posts at once instead of showing the rules first. Dev database only.

use App\Actions\CreateCommit;
use App\Enums\CommitStatus;
use App\Models\Commit;
use App\Models\User;

$local = fn (string $username): User => User::query()->firstOrCreate(
    ['username' => $username],
    ['github_id' => "local:{$username}", 'name' => $username],
);

$fans = collect(range(1, 10))->map(fn (int $i): User => $local("glab-fan-{$i}"));

foreach (explode(',', (string) getenv('GLAB_CAST')) as $username) {
    $user = $local($username);
    $user->forceFill([
        'created_at' => now()->subDay(),
        'commit_rules_accepted_at' => $user->commit_rules_accepted_at ?? now(),
    ])->save();
    $user->followers()->syncWithoutDetaching($fans->pluck('id')->all());

    Commit::query()->where('user_id', $user->id)->where('status', CommitStatus::Pending)->update(['status' => CommitStatus::Approved]);

    if (! $user->commits()->approved()->exists()) {
        resolve(CreateCommit::class)->handle($user, "glab warm-up for @{$username}");
        Commit::query()->where('user_id', $user->id)->update(['status' => CommitStatus::Approved]);
    }

    echo "@{$username} ".($user->fresh()->hasGoodReputation() ? 'trusted' : 'NOT trusted').PHP_EOL;
}
