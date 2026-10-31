# Rebuild the original vector mark as a 256px extension icon, without external dependencies.
Add-Type -AssemblyName System.Drawing
$target = Join-Path $PSScriptRoot '../extensions/codex-code-review-usage/media/icon.png'
$bitmap = [System.Drawing.Bitmap]::new(1024, 1024)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = 'AntiAlias'
$graphics.ScaleTransform(4,4)
function RoundedRect($x,$y,$width,$height,$radius,$color) {
    $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $diameter = $radius * 2
    $path.AddArc($x,$y,$diameter,$diameter,180,90)
    $path.AddArc($x+$width-$diameter,$y,$diameter,$diameter,270,90)
    $path.AddArc($x+$width-$diameter,$y+$height-$diameter,$diameter,$diameter,0,90)
    $path.AddArc($x,$y+$height-$diameter,$diameter,$diameter,90,90)
    $path.CloseFigure()
    $brush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml($color))
    $graphics.FillPath($brush,$path)
    $brush.Dispose(); $path.Dispose()
}
function Stroke($coordinates,$color,$width) {
    $pen = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml($color),$width)
    $pen.StartCap = 'Round'; $pen.EndCap = 'Round'; $pen.LineJoin = 'Round'
    $points = for ($i=0; $i -lt $coordinates.Length; $i+=2) { [System.Drawing.PointF]::new($coordinates[$i],$coordinates[$i+1]) }
    $graphics.DrawLines($pen,[System.Drawing.PointF[]]$points)
    $pen.Dispose()
}
RoundedRect 8 8 240 240 52 '#29415f'
RoundedRect 10 10 236 236 50 '#101c30'
Stroke @(70,85,36,128,70,171) '#63ccff' 13
Stroke @(186,85,220,128,186,171) '#63ccff' 13
RoundedRect 90 128 18 43 9 '#899cff'
RoundedRect 119 104 18 67 9 '#63ccff'
RoundedRect 148 79 18 92 9 '#6ce6b1'
Stroke @(116,65,126,75,147,52) '#6ce6b1' 8
Stroke @(94,196,162,196) '#29415f' 6
$graphics.Dispose()
$icon = [System.Drawing.Bitmap]::new(256,256)
$resize = [System.Drawing.Graphics]::FromImage($icon)
$resize.InterpolationMode = 'HighQualityBicubic'
$resize.DrawImage($bitmap,0,0,256,256)
$icon.Save($target,[System.Drawing.Imaging.ImageFormat]::Png)
$resize.Dispose(); $icon.Dispose(); $bitmap.Dispose()
Write-Output $target
