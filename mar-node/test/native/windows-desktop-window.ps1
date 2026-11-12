Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Remote desktop native acceptance'
$form.WindowState = [System.Windows.Forms.FormWindowState]::Maximized
$form.TopMost = $true
$form.KeyPreview = $true
$form.BackColor = [System.Drawing.Color]::Red
$form.Add_Shown({ $form.Activate() })
$form.Add_KeyDown({
    param($sender, $event)
    if ($event.KeyCode -eq [System.Windows.Forms.Keys]::A) {
        [System.IO.File]::WriteAllText($env:MAR_DESKTOP_KEY_RECEIPT, "key-a`n")
    }
})
[System.Windows.Forms.Application]::Run($form)
