import { CONFIG } from './config.js';

// Configuration
const CLIENT_ID = CONFIG.clientId;
const SCOPES = [
    'https://www.googleapis.com/auth/classroom.courses.readonly',
    'https://www.googleapis.com/auth/classroom.coursework.me.readonly',
    'https://www.googleapis.com/auth/classroom.student-submissions.me.readonly',
    'https://www.googleapis.com/auth/classroom.announcements.readonly'
].join(' ');

// State
let codeClient;
let currentUserId = null;
let accessToken = null;
let coursesList = [];
let allAssignments = [];
let allAnnouncements = [];
let currentAbortController = null;

// DOM Elements
const authBtn = document.getElementById('auth-btn');
const revokeBtn = document.getElementById('revoke-btn');
const authStatus = document.getElementById('auth-status');
const authView = document.getElementById('auth-view');
const dashView = document.getElementById('dashboard-view');
const assignmentsGrid = document.getElementById('assignments-grid');
const spinner = document.getElementById('loading-spinner');
const courseFilter = document.getElementById('course-filter');
const refreshBtn = document.getElementById('refresh-btn');
const signoutBtn = document.getElementById('signout-btn');

// Initialize Google GIS
window.onload = function() {
    codeClient = google.accounts.oauth2.initCodeClient({
        client_id: CLIENT_ID,
        scope: SCOPES,
        access_type: 'offline', // Request offline refresh token
        callback: async (response) => {
            if (response && response.code) {
                // Send code to backend
                authStatus.textContent = 'Authenticating with Server...';
                try {
                    const res = await fetch(`${CONFIG.backendUrl}/api/auth`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ code: response.code })
                    });
                    const data = await res.json();
                    
                    if (data.success) {
                        accessToken = data.access_token;
                        currentUserId = data.userId;
                        switchToDashboard();
                        fetchClassroomData();
                        registerPushNotifications(currentUserId);
                    } else {
                        throw new Error('Callback failed');
                    }
                } catch (e) {
                    authStatus.textContent = 'Login Failed: Ensure Node server is running.';
                }
            }
        },
    });
};

// Event Listeners
const tabs = document.querySelectorAll('.tab-btn');
const tabContents = document.querySelectorAll('.tab-content');

tabs.forEach(tab => {
    tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'));
        tabContents.forEach(tc => tc.style.display = 'none');
        tab.classList.add('active');
        document.getElementById(tab.dataset.tab).style.display = 'block';
    });
});

authBtn.addEventListener('click', () => {
    authStatus.textContent = 'Opening Google Login...';
    codeClient.requestCode();
});

signoutBtn.addEventListener('click', handleSignout);
refreshBtn.addEventListener('click', fetchClassroomData);
courseFilter.addEventListener('change', renderAssignments);

function handleSignout() {
    if (currentAbortController) {
        currentAbortController.abort();
        currentAbortController = null;
    }
    setLoading(false); // Clear lingering loading text

    if (accessToken) {
        google.accounts.oauth2.revoke(accessToken, () => {
            accessToken = null;
            authView.style.display = 'flex';
            dashView.style.display = 'none';
            authStatus.textContent = 'Signed out successfully.';
            assignmentsGrid.innerHTML = '';
        });
    } else {
        authView.style.display = 'flex';
        dashView.style.display = 'none';
        assignmentsGrid.innerHTML = '';
    }
}

function switchToDashboard() {
    authView.style.display = 'none';
    dashView.style.display = 'block';
}

// Fetch Logic
async function fetchWithToken(url, options = {}) {
    if (!accessToken) throw new Error("No Access Token");
    const res = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${accessToken}`
        },
        signal: options.signal
    });
    if (!res.ok) throw new Error(`API Error: ${res.status}`);
    return await res.json();
}

async function fetchClassroomData() {
    if (currentAbortController) currentAbortController.abort();
    currentAbortController = new AbortController();
    const signal = currentAbortController.signal;

    try {
        setLoading(true);
        assignmentsGrid.innerHTML = '';
        allAssignments = [];
        
        // 1. Fetch Courses
        const coursesData = await fetchWithToken('https://classroom.googleapis.com/v1/courses?courseStates=ACTIVE', { signal });
        coursesList = coursesData.courses || [];
        
        populateCourseFilter();

        // 2. Fetch Assignments & Submissions concurrently
        const fetchPromises = coursesList.map(async (course) => {
            // Fetch CourseWork
            let works = [];
            try {
                const courseworkData = await fetchWithToken(`https://classroom.googleapis.com/v1/courses/${course.id}/courseWork`, { signal });
                works = courseworkData.courseWork || [];
            } catch (e) {
                console.warn(`Skipping coursework for ${course.name} (Requires student permissions or is empty)`);
            }
            
            // For each coursework, fetch submissions (We could batch or just get submissions per coursework)
            // To save API limits, studentSubmissions.list can list all submissions for a course by omitting courseWorkId
            // Wait, v1/courses/{courseId}/courseWork/-/studentSubmissions gets ALL submissions for a course! Let's use that.
            
            let submissionsMap = {};
            try {
                const subsData = await fetchWithToken(`https://classroom.googleapis.com/v1/courses/${course.id}/courseWork/-/studentSubmissions`, { signal });
                const subs = subsData.studentSubmissions || [];
                subs.forEach(s => {
                    submissionsMap[s.courseWorkId] = s.state; // states: "TURNED_IN", "RETURNED", "CREATED", "NEW", etc.
                });
            } catch (e) {
                console.error("Failed to load submissions for course: " + course.name, e);
            }

            const worksAssigned = works.map(w => {
                return {
                    id: w.id,
                    courseId: course.id,
                    courseName: course.name,
                    title: w.title,
                    dueDate: w.dueDate ? new Date(w.dueDate.year, w.dueDate.month - 1, w.dueDate.day, w.dueTime?.hours || 23, w.dueTime?.minutes || 59) : null,
                    description: w.description,
                    url: w.alternateLink,
                    state: submissionsMap[w.id] || "NEW"
                };
            });

            let announcements = [];
            try {
                const annData = await fetchWithToken(`https://classroom.googleapis.com/v1/courses/${course.id}/announcements`, { signal });
                const anns = annData.announcements || [];
                announcements = anns.map(a => ({
                    id: a.id,
                    courseName: course.name,
                    text: a.text,
                    updateTime: new Date(a.updateTime),
                    url: a.alternateLink
                }));
            } catch (e) {
                console.error("Failed to load announcements for course: " + course.name, e);
            }
            return { worksAssigned, announcements };
        });

        const results = await Promise.all(fetchPromises);
        allAssignments = results.map(r => r.worksAssigned).flat();
        allAnnouncements = results.map(r => r.announcements).flat();
        
        // Render
        renderAssignments();
        renderAnnouncements();
        generateAndRenderRoutine();
    } catch (error) {
        if (error.name === 'AbortError') {
            console.log('Fetch aborted intentionally.');
            return;
        }
        console.error(error);
        assignmentsGrid.innerHTML = '<p class="text-muted" style="grid-column: 1/-1; text-align:center; font-size: 1.2rem; padding: 2rem;">You have no assignments or classes.</p>';
    } finally {
        setLoading(false);
    }
}

function setLoading(isLoading) {
    if (isLoading) {
        spinner.style.display = 'flex';
        refreshBtn.classList.add('spinner'); // add small simple spin if needed
    } else {
        spinner.style.display = 'none';
        refreshBtn.classList.remove('spinner');
    }
}

function populateCourseFilter() {
    courseFilter.innerHTML = '<option value="all">All Courses</option>';
    coursesList.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.name;
        courseFilter.appendChild(opt);
    });
}

// Logic Rules
function calculateLogic(assignment) {
    // Determine if missing or turned in
    const isTurnedIn = assignment.state === "TURNED_IN" || assignment.state === "RETURNED";
    let isMissing = false;
    
    // Priority Logic
    let priorityVal = 0; // default Low
    let priorityLabel = 'Low';
    let priorityClass = 'badge-low';
    let cardClass = 'priority-low';

    const now = new Date();

    if (assignment.dueDate) {
        const timeDiff = assignment.dueDate.getTime() - now.getTime();
        const daysDiff = timeDiff / (1000 * 3600 * 24);

        if (daysDiff < 0 && !isTurnedIn) {
            isMissing = true;
        }

        if (isMissing || (daysDiff >= 0 && daysDiff <= 1)) {
            priorityVal = 2;
            priorityLabel = 'High';
            priorityClass = 'badge-high';
            cardClass = 'priority-high';
        } else if (daysDiff > 1 && daysDiff <= 4) {
            priorityVal = 1;
            priorityLabel = 'Medium';
            priorityClass = 'badge-medium';
            cardClass = 'priority-medium';
        }
    } else {
        // No due date = low priority
    }

    if (isTurnedIn) {
        // override priority if done
        priorityVal = -1;
        priorityLabel = 'Done';
        priorityClass = 'badge-low'; // green
        cardClass = 'priority-low';
    }

    let statusText = isTurnedIn ? "Turned In" : (isMissing ? "Missing" : "Assigned");
    let statusClass = isTurnedIn ? "turned-in" : (isMissing ? "missing" : "assigned");

    return { priorityVal, priorityLabel, priorityClass, cardClass, statusText, statusClass };
}

function renderAssignments() {
    const filterId = courseFilter.value;
    assignmentsGrid.innerHTML = '';

    let filtered = allAssignments.filter(a => filterId === 'all' || a.courseId === filterId);

    // Sort by priority (High -> Medium -> Low -> Done) then Due Date
    const enhanced = filtered.map(a => {
        const pInfo = calculateLogic(a);
        return { ...a, _score: pInfo.priorityVal, pInfo };
    }).sort((a, b) => {
        if (b._score !== a._score) return b._score - a._score;
        if (!a.dueDate && !b.dueDate) return 0;
        if (!a.dueDate) return 1;
        if (!b.dueDate) return -1;
        return a.dueDate - b.dueDate;
    });

    if (enhanced.length === 0) {
        assignmentsGrid.innerHTML = '<p class="text-muted" style="grid-column: 1/-1; text-align:center; font-size: 1.2rem; padding: 2rem;">You have no assignments or classes.</p>';
        return;
    }

    enhanced.forEach((assignment, index) => {
        const { pInfo } = assignment;
        const staggerClass = `stagger-${Math.min(index % 5 + 1, 5)}`;
        
        const dateStr = assignment.dueDate 
            ? assignment.dueDate.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute:'2-digit', hour12: true })
            : 'No due date';

        let tooltipHTML = '';
        if (assignment.description) {
            const safeDesc = assignment.description.replace(/</g, "&lt;").replace(/>/g, "&gt;");
            tooltipHTML = `<div class="card-tooltip">${safeDesc.replace(/\n/g, '<br>')}</div>`;
        }

        const card = document.createElement('div');
        card.className = `assignment-card ${pInfo.cardClass} slide-up ${staggerClass}`;
        
        card.innerHTML = `
            <div class="card-header">
                <div>
                    <div class="course-name">${assignment.courseName}</div>
                    <div class="assignment-title">${assignment.title}</div>
                </div>
                <div class="badge ${pInfo.priorityClass}">${pInfo.priorityLabel} Prioritiy</div>
            </div>
            
            <div class="card-footer">
                <div class="due-date">
                    <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>
                    ${dateStr}
                </div>
                <div class="status ${pInfo.statusClass}">${pInfo.statusText}</div>
            </div>
            ${tooltipHTML}
        `;
        
        // Add click listener to open assignment in Classroom
        card.style.cursor = 'pointer';
        card.addEventListener('click', () => {
            window.open(assignment.url, '_blank');
        });

        assignmentsGrid.appendChild(card);
    });
}

function renderAnnouncements() {
    const list = document.getElementById('announcements-list');
    list.innerHTML = '';
    
    // Sort by newest first
    const sorted = [...allAnnouncements].sort((a, b) => b.updateTime - a.updateTime);
    
    if (sorted.length === 0) {
        list.innerHTML = '<p class="text-muted" style="text-align:center; padding: 2rem; font-size: 1.2rem;">No announcements from your teachers.</p>';
        return;
    }

    sorted.forEach((ann, index) => {
        const staggerClass = `stagger-${Math.min(index % 5 + 1, 5)}`;
        const dateStr = ann.updateTime.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute:'2-digit', hour12: true });
        
        const card = document.createElement('div');
        card.className = `announcement-card slide-up ${staggerClass}`;
        
        let safeText = (ann.text || "").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, '<br>');

        card.innerHTML = `
            <div class="announcement-meta">
                <strong>${ann.courseName}</strong>
                <span>${dateStr}</span>
            </div>
            <div class="announcement-text">${safeText}</div>
        `;
        if (ann.url) {
            card.style.cursor = 'pointer';
            card.addEventListener('click', () => window.open(ann.url, '_blank'));
        }
        list.appendChild(card);
    });
}

function generateAndRenderRoutine() {
    const container = document.getElementById('routine-container');
    container.innerHTML = '';
    
    // Overall Progress Calculation from API
    const totalCount = allAssignments.length;
    const completedCount = allAssignments.filter(a => calculateLogic(a).priorityVal === -1).length;
    const pct = totalCount === 0 ? 0 : Math.round((completedCount / totalCount) * 100);
    
    // Filter to only actionable assignments
    let actionable = allAssignments.map(a => {
        return { ...a, pInfo: calculateLogic(a) };
    }).filter(a => a.pInfo.priorityVal >= 0); // Exclude Done (-1)

    // Generate Schedule Logic
    let scheduleHTML = `
        <div class="routine-progress-container">
            <div class="routine-progress-fill" id="routine-progress-fill" style="width: ${pct}%"></div>
            <div class="routine-progress-text" id="routine-progress-text">${pct}% Class Progress</div>
        </div>
    `;

    if (actionable.length === 0) {
        scheduleHTML += '<div class="routine-summary">You have no pending assignments! <br><br>Enjoy your free time. 🎉</div>';
        container.innerHTML = scheduleHTML;
        return;
    }

    scheduleHTML += `<div class="routine-summary" style="margin-bottom: 2rem;">Based on urgency, here is your optimized Smart Study Routine starting now:</div>`;

    // Sort by priority (High -> Medium -> Low) then Due Date
    actionable.sort((a, b) => {
        if (b.pInfo.priorityVal !== a.pInfo.priorityVal) return b.pInfo.priorityVal - a.pInfo.priorityVal;
        if (!a.dueDate && !b.dueDate) return 0;
        if (!a.dueDate) return 1;
        if (!b.dueDate) return -1;
        return a.dueDate - b.dueDate;
    });

    let timeAccumulator = new Date();
    timeAccumulator.setMinutes(Math.ceil(timeAccumulator.getMinutes() / 15) * 15); // start at next quarter hour
    
    actionable.forEach((task, index) => {
        const staggerClass = `stagger-${Math.min(index % 5 + 1, 5)}`;
        // Pulse only the first item automatically
        const activeClass = index === 0 ? 'active-task' : '';

        let minutesToSpend = 30; // low priority default
        if (task.pInfo.priorityVal === 2) minutesToSpend = 60; // high priority
        if (task.pInfo.priorityVal === 1) minutesToSpend = 45; // medium priority
        
        const startTimeStr = timeAccumulator.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
        timeAccumulator.setMinutes(timeAccumulator.getMinutes() + minutesToSpend);
        
        scheduleHTML += `
            <div class="timeline-item slide-up ${staggerClass} ${activeClass}">
                <div class="timeline-time">${minutesToSpend}m</div>
                <div class="timeline-content" style="border-left: 4px solid var(--${task.pInfo.priorityVal === 2 ? 'priority-high' : (task.pInfo.priorityVal === 1 ? 'priority-medium' : 'priority-low')});">
                    <div style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: 0.4rem;">Start at ${startTimeStr}</div>
                    <strong style="font-size: 1.1rem; display: block; margin-top: 0.2rem;">${task.title}</strong>
                    <div style="font-size: 0.9rem; color: var(--text-muted); margin-top: 0.4rem;">${task.courseName} &bull; ${task.pInfo.priorityLabel} Priority</div>
                </div>
            </div>
        `;
        
        // Add a 10 min break if not the last item
        if (index < actionable.length - 1) {
            const breakTimeStr = timeAccumulator.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
            scheduleHTML += `
                <div class="timeline-item slide-up ${staggerClass}">
                    <div class="timeline-time" style="background: var(--panel-border); color: var(--text-muted); box-shadow: none;">10m</div>
                    <div class="timeline-content" style="opacity: 0.7; padding: 1rem;">
                        <div style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: 0.2rem;">${breakTimeStr}</div>
                        <strong>☕ Short Break</strong>
                    </div>
                </div>
            `;
            timeAccumulator.setMinutes(timeAccumulator.getMinutes() + 10);
        }
    });

    container.innerHTML = scheduleHTML;
}

// ----------------------------------
// Web Push Logic
// ----------------------------------

function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}

async function registerPushNotifications(userId) {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        console.warn('Push not supported by browser.');
        return;
    }

    try {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
            console.log('Notification permission denied.');
            return;
        }

        const registration = await navigator.serviceWorker.register('sw.js');
        console.log("Service Worker registered");

        const keyRes = await fetch(`${CONFIG.backendUrl}/api/vapidPublicKey`);
        const { publicKey } = await keyRes.json();

        const subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(publicKey)
        });

        await fetch(`${CONFIG.backendUrl}/api/subscribe`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId, subscription })
        });
        console.log("Push notifications successfully configured with backend!");
    } catch (err) {
        console.error('Push Config Error:', err);
    }
}
