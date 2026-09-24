@{
    # Agent je skripta za automatizaciju: izlaz ide u zapisnik, a funkcije koje mijenjaju sustav
    # imaju vlastiti DryRun umjesto -WhatIf/ShouldProcess.
    ExcludeRules = @(
        'PSUseShouldProcessForStateChangingFunctions',
        'PSAvoidUsingWriteHost',
        'PSUseSingularNouns',
        'PSUseBOMForUnicodeEncodedFile',
        'PSAvoidUsingPlainTextForPassword',
        'PSUseApprovedVerbs',
        'PSAvoidGlobalVars'
    )
}
