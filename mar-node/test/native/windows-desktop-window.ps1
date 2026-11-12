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
$form.Add_MouseDown({
    [System.IO.File]::WriteAllText($env:MAR_DESKTOP_MOUSE_RECEIPT, "mouse-down`n")
})
$form.Add_KeyUp({
    param($sender, $event)
    if ($event.KeyCode -eq [System.Windows.Forms.Keys]::A) {
        [System.IO.File]::WriteAllText($env:MAR_DESKTOP_KEY_UP_RECEIPT, "key-up`n")
    }
})
$form.Add_MouseUp({
    [System.IO.File]::WriteAllText($env:MAR_DESKTOP_MOUSE_UP_RECEIPT, "mouse-up`n")
})
[System.Windows.Forms.Application]::Run($form)
