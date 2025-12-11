var colormapDiv = document.getElementById("colormapDiv")

// --- Dropdown Logic ---
function toggleDropdown(id) {
    var element = document.getElementById(id);
    element.classList.toggle('open');
    if (element.style.display === "block") {
        element.style.display = "none";
    } else {
        element.style.display = "block";
    }
}

// --- Helper: Clean Parameter Change ---
// Prevents "Double Download" by handling URL update and reload in one clean step
window.changeParameter = function(newVar, newLev) {
    // 1. Update URL search params cleanly
    const url = new URL(window.location.href);
    if (newVar) url.searchParams.set('variable', newVar);
    if (newLev) url.searchParams.set('level', newLev);
    
    // 2. Push state once
    window.history.pushState({}, '', url);

    // 3. Trigger global reload
    if (typeof window.reloadImagesPrepare === 'function') {
        window.reloadImagesPrepare();
    }
};


// --- Slider Logic ---
const slider = document.getElementById('timeSlider')
const fillLeft = document.querySelector('.fill-left');
const unavailableRectangle = document.querySelector('.unavailable-rectangle');
const sliderContainer = document.querySelector('.slider-container');

let isPlaying = false; 
let playInterval; 
const playPauseButton = document.getElementById('animateButton');

// Block the slider from entering unavailable territory manually
slider.addEventListener('input', function() {
    // Get currently available frames count
    const available = (window.baseFrameCount || 1) - 1;
    
    // Check if we are in "Waiting Mode" (targetFrameIndex defined in stream.js)
    // If waiting, we allow the slider to be ahead. If not, we block it.
    const isWaiting = (typeof window.targetFrameIndex !== 'undefined' && window.targetFrameIndex !== -1);
    
    if (!isWaiting && parseInt(this.value) > available) {
        this.value = available; // Snap back
    }
    
    updateSliderUI();
});

playPauseButton.addEventListener('click', () => {
    isPlaying = !isPlaying;
    playPauseButton.querySelector('.play-icon').style.display = isPlaying ? 'none' : 'block';
    playPauseButton.querySelector('.pause-icon').style.display = isPlaying ? 'block' : 'none';

    if (isPlaying) {
        const delay = 500; 
        playInterval = setInterval(() => {
            const maxFramesReceived = window.baseFrameCount || 1;
            const maxValue = Math.max(0, maxFramesReceived - 1);
            let sliderValue = parseInt(slider.value);

            if (sliderValue < maxValue) {
                slider.value = sliderValue + 1;
            } else {
                slider.value = 0; // Loop
            }

            slider.dispatchEvent(new Event('input')); 
        }, delay);
    } else {
        stopPlaying();
    }
});

function stopPlaying() {
    clearInterval(playInterval);
    isPlaying = false;
    playPauseButton.querySelector('.play-icon').style.display = 'block';
    playPauseButton.querySelector('.pause-icon').style.display = 'none';
}


window.updateSliderUI = function() {
    const sliderValue = parseInt(slider.value);
    const min = parseInt(slider.min);
    
    if (typeof window.baseFrameCount === 'undefined') window.baseFrameCount = 0;
    
    // 1. Set Max (Theoretical)
    // Kept your logic, just ensured it defaults correctly
    if (model == "HRRR") {
        slider.max = [0, 6, 12, 18].includes(runNb) ? 48 : 18;
    } else if (model == "HRRRSH") {
        slider.max = 18 * 4;
    } else if (model == "NAMNEST") {
        slider.max = 60;
    } else if (model == "HRDPS") {
        slider.max = 48;
    } else { 
        slider.max = Math.max(48, window.baseFrameCount);
    }
    
    const max = parseInt(slider.max);
    
    // 2. Visual Bars
    // Blue Fill (Position)
    const leftPercent = (sliderValue / max) * 100;
    fillLeft.style.width = `${leftPercent}%`;

    // Gray Unavailable (Future)
    // "Corrected" logic: Calculate exact start percentage based on downloaded frames
    // If we have 5 frames (idx 0-4), the 5th tick is the first unavailable.
    const framesRx = window.baseFrameCount || 0;
    
    // If framesRx = 0, unavailable starts at 0%. If framesRx = max, unavailable is 100% (off screen)
    // Note: slider range is 0 to max. Total steps = max + 1? Usually max is the last value.
    // Let's assume linear mapping.
    let availablePct = (framesRx / (max + 1)) * 100;
    
    // Clamp
    if (availablePct > 100) availablePct = 100;
    if (availablePct < 0) availablePct = 0;

    unavailableRectangle.style.left = `${availablePct}%`;
    unavailableRectangle.style.width = `${100 - availablePct}%`;
}